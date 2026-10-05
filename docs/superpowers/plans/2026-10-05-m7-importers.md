# M7 Importers: OpenClaw and Hermes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the complete M7 importers (`plur1bus import <openclaw|hermes>`), taking over legacy OpenClaw and Hermes installations into the harness. Supports dry-run by default, copy-never-move, single-writer safety (refusing writes if target core is running), idempotent resumability, pre-apply snapshotting, atomic rollback, secret leasing via allowlist (failing closed before M2), curated file migration (D14/D15) into agent workspace directories, and LanceDB vector store take-over (matching identity and store format version) or guided re-embedding migration (mismatched identity).

**Architecture:** The Rust CLI (`plur1bus import <SOURCE> [FLAGS]`) invokes Node on `import.js` (an esbuild entry of `packages/core` shipping beside `core.js`). Node parses and plans the migration, emits JSON envelopes (`schema: "import.plan/1"`, `"import.apply/1"`, `"import.rollback/1"`) or human-readable summaries, redacting all sensitive secrets and raw memory contents. The importer runs offline as a standalone process (ADR-012) and enforces the single-writer rule: before modifying target state, it checks `l.coreLock` and `l.corePid` and refuses with `target-running` if an active core is detected. Memory cards are ingested exclusively through the engine API (`memory.import`), never directly written to LanceDB (D28/T7).

**Tech Stack:** Rust 1.95 (clap, serde_json), Node 24.21 TypeScript run with `--experimental-strip-types`, `node:sqlite`, `@cyb3rb1ade/plur1bus-memory` (contract 1.10.0+), esbuild.

**Spec & Authorities:** `docs/import.md` (§1–§7 binding; amended by §8/§9), `docs/milestones.md` §M7, ADR-003 (agent model), ADR-006 (provider & model matrix), ADR-007 (users/roles/identity), ADR-009 (cron & dreaming scheduler), ADR-012 (process model), decisions D14 (`SOUL.md` persona preserved), D15 (curated file split: `memories.md`, `knowledgepool.md`, `dreaming.md`, `DailyNote_*`), D28 (one-time takeover, one store = one engine owner), T7 (engine-owned memory store).

---

## Harness Dependencies Audit & Missing APIs on `main`

The importer targets the harness home directory layout and configuration schema. An audit of `origin/main` reveals four harness capabilities not yet finalized on `main`. Each is identified below with its blocker status, the architectural plan, and the exact dependency requirement:

1. **Agent Registration and Workspace Scaffolding (Resolved / No Blocker):**
   - *Status on `main`:* `packages/core/src/agents.ts` defines `scaffoldFiles(l, id)` (lines 12–18) and `createAgentRegistry(configOrPath, l)`. Agents are declared in `config.agents` within `config.json`. Workspaces resolve to `l.workspaceDir(id)` (`<home>/agents/<id>/workspace`, per `packages/core/src/paths.ts` lines 30–41).
   - *Resolution:* There is **no `registry.json`**. The importer operates in offline mode: it updates `config.agents` in `config.json` via the config updater and calls `scaffoldFiles(l, id)` to scaffold the agent workspace. Curated markdown files are written directly into `l.workspaceDir(id)`.

2. **Memory Card Ingestion API (`memory.import`) (BLOCKER for Engine PR - grok):**
   - *Status on `main`:* `packages/core/src/engine.ts` and `@cyb3rb1ade/plur1bus-memory` (contract 1.10.0) expose `recall`, `list`, `show`, `forget`, `correct`, `share`, `state`, `propose`, `proposals.*`. Direct memory card insertion (`memory.import` / `memory.write`) is **not exposed** in contract 1.10.0.
   - *Rule:* **D28 / T7 (one store = one engine owner).** The importer must **never** write directly into LanceDB tables via `@lancedb/lancedb`. Re-implementing the schema, embedding generation, deduplication, and provenance outside the engine violates architectural boundaries and will diverge on the next engine upgrade. Cards must go **only through the engine**.
   - *Blocker severity:* High (blocks Hermes memory card import in Batch 3).
   - *Resolution:* A dedicated engine operation `memory.import({ agentId, cards, provenance: "imported" })` is required. The detailed API specification is provided in [Proposed Engine API for grok (`memory.import`)](#proposed-engine-api-for-grok-memoryimport) below. Batch 3 memory card import is paused pending this engine PR.

3. **Store Take-Over, Format Verification & Single-Writer Rule:**
   - *Status on `main`:* Matching-identity LanceDB partition copying (`copy-never-move`) requires single-writer safety and engine compatibility verification.
   - *Rule:*
     - **Single-Writer Safety:** Before any write to target harness home, the importer checks `l.coreLock` (`<home>/state/core.lock`) and `l.corePid` (`<home>/run/core.pid`). If an active core is running, the importer refuses immediately with `target-running`.
     - **Store Format Version:** In addition to embedding identity, the importer inspects the source store format schema version against `EngineStatus.storeSchema` of the pinned engine. A store from an incompatible or newer engine version must not be taken over blindly; it must be flagged for re-embedding or migration.
     - **Store Registration:** The importer registers stores through the engine's designated store layout and registration path, never writing ad-hoc manifest files by hand.

4. **Secret Store (BLOCKER for M2):**
   - *Status on `main`:* The official harness secret store (`@napi-rs/keyring` + encrypted file fallback) is scheduled for M2.
   - *Rule:* **No makeshift secret store.** A file-backed stub secret store prior to M2 creates an insecure second secret store that will be discarded.
   - *Resolution:* Until M2 lands, `--migrate-secrets` is **refused** with error reason `secret-store-unavailable`. The import report lists only allowlisted key names (e.g. `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`) that are available for future migration, with **zero secret values**. The `SecretLeaseTarget` interface is retained in `packages/core/src/import/secrets-lease.ts`, with an in-memory fake used solely in unit tests.

5. **Harness General Cron Scheduler (BLOCKER for ADR-009 / M2-M3):**
   - *Status on `main`:* The general cron runner is not yet implemented on `main` (only the discovery jitter scheduler exists).
   - *Rule:* **Do not invent `<home>/cron/jobs.json`.**
   - *Resolution:* Until the ADR-009 scheduler is merged, cron jobs from legacy installations are reported as **"deferred"** in the import report (count, names, schedule expressions, delivery target, no prompt contents). **Zero files are written to disk.** Full cron import is a follow-up for the scheduler milestone.

---

## Proposed Engine API for grok (`memory.import`)

To preserve **D28 / T7 (one store = one engine owner)** without bypassing the engine or using `@lancedb/lancedb` directly, the PLUR1BUS engine requires an additive `memory.import` operation on `MemoryOps` (contract 1.11.0 / engine PR for grok):

### TypeScript Interface Specification

```ts
// packages/core/node_modules/@cyb3rb1ade/plur1bus-memory/types/engine.d.ts

export interface MemoryImportCardInput {
  scope: MemoryScope;                 // "agent-private" | "workspace" | "user"
  text: string;                       // Card text content
  summary?: string;                   // Optional summary; generated if omitted
  createdAt?: number;                 // Epoch ms timestamp from source; defaults to Date.now()
  origin?: string;                    // e.g. "import:hermes:MEMORY.md" or "import:openclaw"
  epistemicStatus?: string;           // Optional epistemic tag
  principal?: Principal;              // Target principal binding
}

export interface MemoryImportRequest {
  agentId: AgentId;
  cards: MemoryImportCardInput[];
  provenance: "imported";             // Mandatory provenance tag
  options?: {
    dedup?: "content-hash" | "exact"; // Deduplication strategy (default "content-hash")
    signal?: AbortSignal;
  };
}

export interface MemoryImportCardResult {
  id: string;                         // Assigned card ID
  status: "created" | "duplicate" | "skipped";
}

export interface MemoryImportResult {
  agentId: AgentId;
  imported: number;                   // Number of cards successfully embedded & stored
  skipped: number;                    // Number of duplicates / skipped cards
  cards: MemoryImportCardResult[];
}

export interface MemoryOps {
  // Existing: list, show, forget, correct, share, state, propose, proposals...
  
  /**
   * Bulk import legacy memory cards into the agent's memory store.
   * Embeds texts using the active engine embedder, enforces store schema,
   * handles deduplication, and records provenance="imported".
   *
   * Rejects with MemoryOpError:
   *   - "storage": engine is closed or storage write failed
   *   - "invalid-input": malformed card structure, invalid scope, or empty batch
   *   - "conflict": provenance is not "imported"
   *   - "target-running": store is locked by another writer
   */
  import(req: MemoryImportRequest, p: Principal, a: AgentContext): Promise<MemoryImportResult>;
}
```

### Engine Behavior & Semantics
1. **Embedding Generation:** The engine chunks/embeds each card using its active embedding model and dimension, ensuring vectors match the active store.
2. **Schema & Indices:** Cards are written to the engine's internal LanceDB table and FTS index with `provenance: "imported"`.
3. **Deduplication:** Uses content-hash deduplication against existing cards in the store to prevent duplicate writes during re-import.
4. **Error Handling:** Returns atomic summary; if the batch partially fails, rolls back or reports individual card statuses.

---

## Blocker Ordering & Immediate Work

To maintain steady progress without violating architectural boundaries, work is partitioned by blocker dependencies:

```
┌─────────────────────────────────────────────────────────────────┐
│ Immediate Work (Batch 2 - Unblocked)                            │
│ - Agent discovery & parsing (openclaw.json / config.yaml)       │
│ - Target single-writer check (l.coreLock, l.corePid)            │
│ - Agent registration in config.agents & scaffoldFiles(l, id)    │
│ - Persona (SOUL.md) & D15 files -> l.workspaceDir(id)           │
│ - Channel allowlist extraction & mapping                        │
│ - Deferred cron reporting (zero disk writes)                    │
│ - Secret allowlist reporting & fail-closed refusal              │
│ - Dry-run plan & apply reports                                  │
└────────────────────────────────┬────────────────────────────────┘
                                 │
     ┌───────────────────────────┴───────────────────────────┐
     ▼                                                       ▼
┌───────────────────────────────┐       ┌───────────────────────────────┐
│ Waits for Engine PR (grok)    │       │ Waits for Future Milestones   │
│ - Store format schema check   │       │ - M2: Secret Store Migration  │
│ - Engine store registration   │       │   (--migrate-secrets)         │
│ - Batch 3: Hermes card import │       │ - ADR-009: Cron Store/Runner  │
│   via engine memory.import()  │       │   (execute deferred crons)    │
└───────────────────────────────┘       └───────────────────────────────┘
```

---

## Open Owner Question: ADR-007 Q4 (Unlink Semantics)

- **The Question (ADR-007 Q4):** When unlinking a channel identity (e.g. Telegram user ID) from a v2 user principal during import/migration, should the old identity's memories be hidden from the v2 principal or back-filled to the v2 principal?
- **Owner Decision:**
  - **Metadata-only back-fill to the v2 user principal (dry-runnable, audit-logged) before unlinking.**
  - *Status:* **Approved Owner Decision.** Implementation follows this decision once the v2 principal migration logic is wired.
  - *Rationale:* User memories represent valuable personal context. Discarding or hiding them causes perceived data loss. Back-filling updates the memory card's `principalId` attribute to the v2 principal while appending an audit record (`actor: "import", action: "backfill-identity"`).
  - *Opt-out:* If the operator chooses `--no-identity-backfill`, the memories remain bound to the legacy v1 principal (`user:v1:<hash>`) and remain inaccessible to the unlinked v2 principal (fail-closed per §2.4).

---

## Global Constraints & Principles

- **Single-Writer Safety:** Before touching target harness home, verify `l.coreLock` and `l.corePid`. If active, exit immediately with `target-running`.
- **Dry-run is the default:** Every command without `--apply` generates plans and reports with zero filesystem writes.
- **Copy-never-move:** Source files are strictly read-only. Source databases are copied to private temp directories before inspection; no files in the source are ever modified or removed.
- **Store Ownership (D28/T7):** The engine owns the LanceDB store. Never write directly to LanceDB from the importer; route cards through `memory.import`.
- **Idempotent & Resumable:** An import run writes an atomic progress ledger. Re-running with `--apply` detects existing entities via idempotency keys and converges with zero duplicate writes (`matched-existing`).
- **Pre-apply Snapshot & Rollback:** Before any target state is modified, a restorable snapshot is saved to `<home>/imports/<runId>/snapshot/`. `--rollback <report>` verifies hashes and restores state atomically.
- **Privacy & Safety:** Reports (JSON and human-readable) contain NO secret values, NO token strings, and NO memory/message content. Secret values are never written to disk.
- **Timeouts:** Every test and external command has a hard timeout; no unbounded waits.

---

## Effort Breakdown (Total: 16–25 ad)

*Note: The desktop wizard belongs to M3/D2 and is excluded from M7. Batch 4 is realistically estimated at 4–6 ad.*

| Batch | Scope | Effort | Status |
|---|---|---|---|
| **Batch 1** | **Synthetic Fixture Generator** (OpenClaw & Hermes, 2 embedding identities, OS layouts, smoke tests) | **3–5 ad** | Delivered in PR #91 |
| **Batch 2** | **OpenClaw Importer** (Agents in `config.agents`, `SOUL.md` & D15 in `l.workspaceDir`, single-writer check, store takeover vs re-embedding, channels, deferred cron) | **5–8 ad** | Ready to start |
| **Batch 3** | **Hermes Importer** (Profiles → agents, `SOUL.md`, `§`-cards via `memory.import`, pairings, deferred cron, sessions excluded) | **4–6 ad** | Memory cards blocked on engine PR |
| **Batch 4** | **Cross-Cutting Pipeline, Ledger, Reports & Rollback** (Idempotency ledger, target pre-apply snapshot/rollback, secret lease refusal, sanitized reports, Rust/Node CLI) | **4–6 ad** | Follows Batches 2 & 3 |
| *Note* | *Cross-platform sources (WSL discovery, snapshot producer, tar streaming) completed in #85/#90* | *3–5 ad* | Merged to `main` |

---

## Detailed TDD Batches & Tasks

### Batch 1: Synthetic Fixture Generator (3–5 ad) — *Delivered in this PR*

**Goal:** Deliver deterministic, completely synthetic fixture generators for OpenClaw and Hermes across Linux, macOS, and Windows layouts, featuring two embedding identities (matching E5 384-d and mismatched NANO 768-d) and all M7 artifact files, verified by smoke tests against `detect`.

- [x] **Task 1.1: Design Fixture Interfaces & Embedding Models**
  - Files: `packages/core/test/import/fixtures.ts`, `packages/core/test/import/layouts.ts`
  - Defines `intfloat/multilingual-e5-small` (384-d, matching target default) and `jinaai/jina-embeddings-v5-text-nano-retrieval` (768-d, mismatched).
  - Provides helper methods for synthetic LanceDB stores, SQLite state databases, curated markdown files, and pairing files.
- [x] **Task 1.2: Implement OpenClaw M7 Fixtures across OS Layouts**
  - Synthetic `openclaw.json` with agents `alpha` (matching 384-d) and `beta` (mismatched 768-d), channels allowlist (`allowFrom`), provider configs with `FAKE_TOKEN`.
  - LanceDB store partitions for `alpha` (384-d), `beta` (768-d), and `.plur1bus-shared/workspaces` (384-d).
  - Curated files in `ws-alpha`: `SOUL.md`, `MEMORY.md`, `USER.md`, `memory/2026-01-01.md`, `DREAMS.md` (managed phase blocks), `KNOWLEDGE.md`.
  - SQLite state database with `schema_meta` and `cron_jobs` (user jobs + excluded dreaming job).
  - Auth profiles: SQLite auth in `agents/alpha/agent/openclaw-agent.sqlite`, legacy JSON in `agents/beta/agent/auth-profiles.json`.
- [x] **Task 1.3: Implement Hermes M7 Fixtures across OS Layouts**
  - Multi-profile Hermes installation: root (`default`, matching 384-d) and `profiles/work` (mismatched 768-d).
  - `config.yaml` with `_config_version: 45`, `memory.provider: plur1bus` with embedding configurations.
  - `state.db` SQLite with `schema_version = 30`, session lineage (`parent_session_id`), messages with `CONTENT_MARKER`.
  - Curated memory files: `SOUL.md`, `memories/MEMORY.md` and `memories/USER.md` with `\n§\n` delimited entries.
  - Cron definitions in `cron/jobs.json`.
  - Platform pairings: `platforms/pairing/telegram-approved.json` (imported) and `telegram-pending.json` (excluded).
- [x] **Task 1.4: Smoke Tests & Validation**
  - Files: `packages/core/test/import/fixtures.test.ts`
  - Verifies that `detect` recognises all agents/profiles, store dimensions (384 vs 768), identity comparison verdicts, skills, and secrets.
  - Asserts that no fixture token or content marker ever leaks into detect output.

---

### Batch 2: OpenClaw Importer (5–8 ad)

**Goal:** Implement the OpenClaw import pipeline (`importOpenclaw`), taking over agents into `config.agents`, curated files (D15) into `l.workspaceDir(id)`, enforcing single-writer locks, verifying LanceDB store format versions, mapping channel allowlists, and reporting cron jobs as deferred.

- [ ] **Task 2.1: Target Single-Writer Check, Agent Registration & Curated File Migration**
  - Files: `packages/core/src/import/importers/openclaw-agents.ts`
  - Verifies single-writer safety: checks `l.coreLock` (`<home>/state/core.lock`) and `l.corePid` (`<home>/run/core.pid`); aborts with `target-running` if core is running.
  - Registers agents in `config.agents` within `config.json` and runs `scaffoldFiles(l, agentId)` (`packages/core/src/agents.ts` lines 12–18). There is NO `registry.json`.
  - Copies `ws/SOUL.md` to `l.workspaceDir(agentId)/SOUL.md` (D14: preserved persona).
  - Maps D15 curated files to the agent workspace directory (`packages/core/src/paths.ts` lines 30–41, `l.workspaceDir(id) = <home>/agents/<id>/workspace`):
    - `workspace/MEMORY.md` → `l.workspaceDir(agentId)/memories.md`
    - `KNOWLEDGE.md` → `l.workspaceDir(agentId)/knowledgepool.md`
    - `workspace/DREAMS.md` → `l.workspaceDir(agentId)/dreaming.md` (for human historical reference; harness scheduler writes own markers)
    - `workspace/memory/YYYY-MM-DD*.md` → `l.workspaceDir(agentId)/DailyNote_YYYY-MM-DD_HHMMSS.md`
- [ ] **Task 2.2: LanceDB Store Take-Over & Store Format Verification**
  - Files: `packages/core/src/import/importers/openclaw-stores.ts`
  - Evaluates source store embedding identity against target configuration:
    - **Match:** Checks store schema format version against pinned engine (`EngineStatus.storeSchema`). If compatible, copies LanceDB store partition (`copy-never-move`) and registers store via the engine's store directory convention. If format version is incompatible/newer, halts blind take-over and routes to migration.
    - **Mismatch:** Prepares guided re-embedding plan: creates staging generation, flags for background re-embedding migration.
  - Copies `.plur1bus-shared/` partitions and `.adaptive-learning/` audit logs verbatim.
- [ ] **Task 2.3: Channel Allowlists & Deferred Cron Reporting**
  - Files: `packages/core/src/import/importers/openclaw-channels.ts`, `openclaw-cron.ts`
  - Reads `channels.<platform>.allowFrom` from `openclaw.json` → maps to harness bot-connection allowlists.
  - Reads `cron_jobs` table from `state/openclaw.sqlite`:
    - Reports user-authored jobs as **"deferred"** in the import report (count, names, schedule expressions, delivery target; zero disk writes; no prompt content).
    - Excludes managed jobs (`memory-core:*`, PLUR1BUS feature crons) per §2.2.
- [ ] **Task 2.4: Unit & Integration Tests**
  - Tests single-writer refusal when target `core.lock` exists.
  - Tests agent registration in `config.agents` and file placement in `l.workspaceDir(id)`.
  - Tests matching store takeover with store format version check.
  - Tests mismatched store routing into re-embedding migration.
  - Tests deferred cron reporting with zero filesystem writes.

---

### Batch 3: Hermes Importer (4–6 ad)

**Goal:** Implement the Hermes import pipeline (`importHermes`), taking over profiles, scaffolding agent workspaces, importing approved pairings, reporting crons as deferred, and ingesting `§`-delimited memory cards via the engine `memory.import` API (pending engine PR).

- [ ] **Task 3.1: Profile Enumeration, Agent Scaffolding & Persona Migration**
  - Files: `packages/core/src/import/importers/hermes-agents.ts`
  - Checks target single-writer lock (`l.coreLock` / `l.corePid`).
  - Maps default profile and `profiles/<name>` to harness agents.
  - Registers agents in `config.agents` and invokes `scaffoldFiles(l, agentId)`.
  - Copies `SOUL.md` and `USER.md` into `l.workspaceDir(agentId)`.
- [ ] **Task 3.2: Delimited Memory Migration via Engine `memory.import` (BLOCKED on Engine PR)**
  - Files: `packages/core/src/import/importers/hermes-memories.ts`
  - Parses `memories/MEMORY.md` and `memories/USER.md` on `\n§\n` delimiter.
  - Calls engine API `memory.import({ agentId, cards, provenance: "imported" })`.
  - Never writes directly to LanceDB via `@lancedb/lancedb` (D28/T7).
  - Writes curated markdown mirrors (`memories.md`, `USER.md`) to `l.workspaceDir(agentId)`.
- [ ] **Task 3.3: Pairing Allowlists & Deferred Cron Reporting**
  - Files: `packages/core/src/import/importers/hermes-platforms.ts`, `hermes-cron.ts`
  - Scans `platforms/pairing/*-approved.json` → imports approved user IDs into channel allowlists.
  - Scans `platforms/pairing/*-pending.json` → explicitly **excludes** pending one-time codes (§3.2).
  - Reads `cron/jobs.json` → reports user jobs as **"deferred"** in import report (zero disk writes).
- [ ] **Task 3.4: Sessions (Deferred / Out of M7)**
  - Per `docs/import.md` §3 and the OpenClaw row, session history is sensitive and not imported by default.
  - Marked as **deferred / out of M7**.
- [ ] **Task 3.5: Unit & Integration Tests**
  - Tests card splitting on `§` and invocation of `memory.import` with provenance `imported`.
  - Tests pending pairings exclusion and approved pairings inclusion.
  - Tests profile isolation and idempotency.

---

### Batch 4: Cross-Cutting Pipeline, Ledger, Reports & Rollback (4–6 ad)

**Goal:** Unify the importer pipeline with an atomic idempotency ledger, pre-apply snapshotting, full rollback, sanitized reports, secret leasing refusal (failing closed before M2), and Rust/Node CLI integration.

- [ ] **Task 4.1: Idempotency Ledger & Conflict Resolution**
  - Files: `packages/core/src/import/ledger.ts`, `conflicts.ts`
  - Computes entity idempotency keys (`agentId`, store hash, skill name/version, cron job hash, memory entry hash).
  - Progressively records applied writes to `<home>/imports/<runId>/ledger.jsonl`.
  - Implements conflict strategies: `skip` (default), `rename`, `replace`.
- [ ] **Task 4.2: Pre-Apply Snapshot & Rollback Engine**
  - Files: `packages/core/src/import/snapshot-target.ts`, `rollback.ts`
  - Snapshots target agent dirs, stores, skills, and config prior to apply.
  - Restores target state from snapshot upon `plur1bus import --rollback <report>`.
- [ ] **Task 4.3: Secret Store Refusal & Allowlist Reporting (Until M2)**
  - Files: `packages/core/src/import/secrets-lease.ts`
  - When `--migrate-secrets` is passed, refuses with error code `secret-store-unavailable`.
  - Lists allowlisted secret keys (`TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, etc.) in report under `unmigrated_secrets`, with **zero secret values**.
  - Retains `SecretLeaseTarget` interface with in-memory test fake for testing only.
- [ ] **Task 4.4: Report Generation & Sanitization**
  - Files: `packages/core/src/import/reports.ts`, `render.ts`
  - Emits JSON report conforming to `docs/import.md` §5.7 and human-readable text.
  - Automated assertions verify zero secrets, tokens, or content markers in report output.
- [ ] **Task 4.5: CLI Integration (Rust & Node)**
  - Wire CLI arguments in Rust CLI and `import-bin.ts`.
  - Desktop wizard is explicitly excluded (belongs to M3/D2).

---

## Verification & Acceptance Checklist

1. [ ] **Dry-Run Default:** A bare import invocation performs zero writes to source or target and returns a complete preview report.
2. [ ] **Single-Writer Safety:** An import attempt against a running target home (with active `core.lock` or `core.pid`) fails closed with `target-running`.
3. [ ] **Byte-Identical Source:** Fixture source directories are bit-for-bit identical before and after import.
4. [ ] **Store Take-Over without Re-Embedding:** Matching embedding identity store (alpha, 384-d E5) is taken over directly only after store schema format compatibility is verified.
5. [ ] **Engine Store Ownership:** All memory cards are ingested through `memory.import`; no direct LanceDB writes occur.
6. [ ] **Guided Re-Embedding Routing:** Mismatched store (beta, 768-d NANO) is routed to re-embedding migration.
7. [ ] **Hermes Cards & Pairing:** `MEMORY.md` entries land with provenance `imported`; approved pairing lists are imported; pending pairing codes are excluded.
8. [ ] **Secret Safety (pre-M2):** `--migrate-secrets` fails closed with `secret-store-unavailable`; report lists only key names without values.
9. [ ] **Deferred Cron:** Cron jobs are reported as deferred; zero cron files written prior to ADR-009 scheduler.
10. [ ] **Idempotency:** A second run against an imported target produces zero writes and reports `matched-existing` for all entities.
11. [ ] **Rollback:** `import --rollback` restores the pre-import target state completely.
12. [ ] **Zero Leaks:** Automated scans confirm no `FAKE_TOKEN` or `CONTENT_MARKER` appears in any report.
