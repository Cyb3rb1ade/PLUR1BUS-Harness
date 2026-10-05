# M7 Importers: OpenClaw and Hermes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the complete M7 importers (`plur1bus import <openclaw|hermes>`), taking over legacy OpenClaw and Hermes installations into the harness. Supports dry-run by default, copy-never-move, idempotent resumability, pre-apply snapshotting, atomic rollback, secret leasing via allowlist, curated file migration (D14/D15), and LanceDB vector store take-over (matching identity) or guided re-embedding migration (mismatched identity).

**Architecture:** The Rust CLI (`plur1bus import <SOURCE> [FLAGS]`) invokes Node on `import.js` (an esbuild entry of `packages/core` shipping beside `core.js`). Node parses and plans the migration, emits JSON envelopes (`schema: "import.plan/1"`, `"import.apply/1"`, `"import.rollback/1"`) or human-readable summaries, redacting all sensitive secrets and raw memory contents. The importer never runs inside the core daemon process and requires no running supervisor.

**Tech Stack:** Rust 1.95 (clap, serde_json), Node 24.21 TypeScript run with `--experimental-strip-types`, `node:sqlite`, `@lancedb/lancedb` 0.26 (via the engine), esbuild.

**Spec & Authorities:** `docs/import.md` (§1–§7 binding; amended by §8/§9), `docs/milestones.md` §M7, ADR-003 (agent model), ADR-006 (provider & model matrix), ADR-007 (users/roles/identity), ADR-009 (cron & dreaming scheduler), ADR-012 (process model), decisions D14 (`SOUL.md` persona preserved), D15 (curated file split: `memories.md`, `knowledgepool.md`, `dreaming.md`, `DailyNote_*`), D28 (one-time takeover, one store = one engine owner).

---

## Harness Dependencies Audit & Missing APIs on `main`

The importer targets the harness home directory and data model. An audit of `origin/main` reveals four harness capabilities not yet finalized on `main`. Each is identified below with its blocker status and the architectural plan to work around it during M7:

1. **`agent.create` Saga (M3):**
   - *Status on `main`:* `packages/core/src/agents.ts` contains `scaffoldFiles` and `createAgentRegistry`, but the full distributed saga (`agent.create` RPC, provider wiring, supervisor notification) is scheduled for M3.
   - *Blocker severity:* High for live RPC calls, Low for offline import.
   - *Resolution / Workaround:* The importer operates directly on the target harness home layout (offline/standalone process model, ADR-012). It scaffolds the agent directory (`<home>/agents/<agentId>/`), writes `SOUL.md` and curated files, and registers the agent in `<home>/agents/registry.json` using the existing `createAgentRegistry` format. When M3 lands, the importer can optionally dispatch through the agent-create saga.

2. **Memory Write API (Direct Card Insert) (M1b/M2/M3):**
   - *Status on `main`:* `MEMORY_OP_METHODS` on `main` supports `list`, `show`, `forget`, `correct`, `share`, `state`, `propose`, `proposals.*`. Direct memory card insertion (`memory.insert` / `memory.write`) is not exposed on `main`.
   - *Blocker severity:* Medium.
   - *Resolution / Workaround:*
     - **OpenClaw:** Stores are taken over as full LanceDB directories (`copy-never-move`), journals, and manifests; no card-by-card insertion is required. Curated markdown files (`memories.md`, `knowledgepool.md`, `dreaming.md`, `DailyNote_*`) are written directly to the target agent workspace.
     - **Hermes:** `MEMORY.md` and `USER.md` entries (delimited by `\n§\n`) are imported as memory cards with provenance `imported`. The importer writes cards directly to the agent's LanceDB table using `@lancedb/lancedb` matching the engine's memory schema, and writes the curated markdown mirror files.

3. **Secret Store (M2):**
   - *Status on `main`:* `@napi-rs/keyring` and encrypted file fallback (`~/.plur1bus/secrets/`) are M2 deliverables; not present on `main`.
   - *Blocker severity:* Medium.
   - *Resolution / Workaround:* Define a clean `SecretStore` abstraction in `packages/core/src/import/secrets-lease.ts`:
     ```ts
     export interface SecretLeaseTarget {
       leaseSecret(key: string, value: string): Promise<void>;
     }
     ```
     For tests and standalone dry-run/apply before M2, provide a file-backed encrypted/stub lease adapter. When M2 lands, wire the adapter to the official harness secret store. Secrets remain opt-in (`--migrate-secrets`) and allowlist-gated; raw values are held only in ephemeral memory during leasing and never appear in reports.

4. **Harness General Cron Scheduler (ADR-009 / M2-M3):**
   - *Status on `main`:* The general cron runner is not yet implemented on `main` (only the discovery jitter scheduler exists in `discovery/scheduler.ts`).
   - *Blocker severity:* Low.
   - *Resolution / Workaround:* The importer writes imported cron definitions to `<home>/cron/jobs.json` (or the harness cron store schema). Managed dreaming/feature crons (`memory-core:memory-dreaming-promotion`, PLUR1BUS feature crons) are explicitly skipped from generic import per §2.2, as the harness's own scheduler re-provisions them fresh.

---

## Open Owner Question: ADR-007 Q4 (Unlink Semantics)

- **The Question (ADR-007 Q4):** When unlinking a channel identity (e.g. Telegram user ID) from a v2 user principal during import/migration, should the old identity's memories be hidden from the v2 principal or back-filled to the v2 principal?
- **Proposed Default for M7:**
  - **Metadata-only back-fill to the v2 user principal (dry-runnable, audit-logged) before unlinking.**
  - *Rationale:* User memories represent valuable personal context. Discarding or hiding them causes perceived data loss. Back-filling updates the memory card's `principalId` attribute to the v2 principal while appending an audit record (`actor: "import", action: "backfill-identity"`).
  - *Opt-out:* If the operator chooses not to back-fill, the memories remain bound to the legacy v1 principal (`user:v1:<hash>`) and remain inaccessible to the unlinked v2 principal (fail-closed per §2.4).

---

## Global Constraints & Principles

- **Dry-run is the default:** Every command without `--apply` generates plans and reports with zero filesystem writes.
- **Copy-never-move:** Source files are strictly read-only. Source databases are copied to private temp directories before inspection; no files in the source are ever modified or removed.
- **Idempotent & Resumable:** An import run writes an atomic progress ledger. Re-running with `--apply` detects existing entities via idempotency keys and converges with zero duplicate writes (`matched-existing`).
- **Pre-apply Snapshot & Rollback:** Before any target state is modified, a restorable snapshot is saved to `<home>/imports/<runId>/snapshot/`. `--rollback <report>` verifies hashes and restores state atomically.
- **Privacy & Safety:** Reports (JSON and human-readable) contain NO secret values, NO token strings, and NO memory/message content. Secret values are never written to disk except through the lease adapter.
- **Timeouts:** Every test and external command has a hard timeout; no unbounded waits.

---

## Effort Breakdown (Total: 17–27 ad)

| Batch | Scope | Effort |
|---|---|---|
| **Batch 1** | **Synthetic Fixture Generator** (OpenClaw & Hermes, 2 embedding identities, OS layouts, smoke tests) | **3–5 ad** *(Delivered in Task B)* |
| **Batch 2** | **OpenClaw Importer** (Agents, `SOUL.md`, D15 curated files, LanceDB store takeover vs re-embedding, channels, cron) | **5–8 ad** |
| **Batch 3** | **Hermes Importer** (Profiles → agents, `SOUL.md`, `MEMORY.md`/`USER.md` cards with provenance, pairings, cron) | **4–6 ad** |
| **Batch 4** | **Cross-Cutting Pipeline, Ledger, Reports, Rollback & Wizard** (Idempotency ledger, snapshot/rollback, secret lease, wizard) | **2–3 ad** |
| *Note* | *Cross-platform sources (WSL discovery, snapshot producer, tar streaming) already completed in #85/#90* | *3–5 ad (absorbed)* |

---

## Detailed TDD Batches & Tasks

### Batch 1: Synthetic Fixture Generator (3–5 ad) — *Focus of this PR*

**Goal:** Deliver deterministic, completely synthetic fixture generators for OpenClaw and Hermes across Linux, macOS, and Windows layouts, featuring two embedding identities (matching E5 384-d and mismatched NANO 768-d) and all M7 artifact files, verified by smoke tests against `detect`.

- [ ] **Task 1.1: Design Fixture Interfaces & Embedding Models**
  - Files: `packages/core/test/import/fixtures.ts`, `packages/core/test/import/layouts.ts`
  - Defines `intfloat/multilingual-e5-small` (384-d, matching target default) and `jinaai/jina-embeddings-v5-text-nano-retrieval` (768-d, mismatched).
  - Provides helper methods for synthetic LanceDB stores, SQLite state databases, curated markdown files, and pairing files.
- [ ] **Task 1.2: Implement OpenClaw M7 Fixtures across OS Layouts**
  - Synthetic `openclaw.json` with agents `alpha` (matching 384-d) and `beta` (mismatched 768-d), channels allowlist (`allowFrom`), provider configs with `FAKE_TOKEN`.
  - LanceDB store partitions for `alpha` (384-d), `beta` (768-d), and `.plur1bus-shared/workspaces` (384-d).
  - Curated files in `ws-alpha`: `SOUL.md`, `MEMORY.md`, `USER.md`, `memory/2026-01-01.md`, `DREAMS.md` (managed phase blocks), `KNOWLEDGE.md`.
  - SQLite state database with `schema_meta` and `cron_jobs` (user jobs + excluded dreaming job).
  - Auth profiles: SQLite auth in `agents/alpha/agent/openclaw-agent.sqlite`, legacy JSON in `agents/beta/agent/auth-profiles.json`.
- [ ] **Task 1.3: Implement Hermes M7 Fixtures across OS Layouts**
  - Multi-profile Hermes installation: root (`default`, matching 384-d) and `profiles/work` (mismatched 768-d).
  - `config.yaml` with `_config_version: 45`, `memory.provider: plur1bus` with embedding configurations.
  - `state.db` SQLite with `schema_version = 30`, session lineage (`parent_session_id`), messages with `CONTENT_MARKER`.
  - Curated memory files: `SOUL.md`, `memories/MEMORY.md` and `memories/USER.md` with `\n§\n` delimited entries.
  - Cron definitions in `cron/jobs.json`.
  - Platform pairings: `platforms/pairing/telegram-approved.json` (imported) and `telegram-pending.json` (excluded).
- [ ] **Task 1.4: Smoke Tests & Validation**
  - Files: `packages/core/test/import/fixtures.test.ts`
  - Verifies that `detect` recognises all agents/profiles, store dimensions (384 vs 768), identity comparison verdicts, skills, and secrets.
  - Asserts that no fixture token or content marker ever leaks into detect output.

---

### Batch 2: OpenClaw Importer (5–8 ad)

**Goal:** Implement the OpenClaw import pipeline (`importOpenclaw`), taking over agents, curated files (D15), LanceDB stores (matching vs re-embedding), channels, and cron jobs.

- [ ] **Task 2.1: OpenClaw Agent Scaffolding & Persona Migration**
  - Files: `packages/core/src/import/importers/openclaw-agents.ts`
  - Maps `agents.list` / `agents.entries` to harness agents. Preserves `agentId` (or resolves collisions via mapping table).
  - Copies `ws/SOUL.md` to `<home>/agents/<agentId>/SOUL.md` (D14: preserved without renaming).
  - Maps D15 curated files:
    - `workspace/MEMORY.md` → `<home>/agents/<agentId>/memories.md`
    - `KNOWLEDGE.md` → `<home>/agents/<agentId>/knowledgepool.md`
    - `workspace/DREAMS.md` → `<home>/agents/<agentId>/dreaming.md` (for human historical reference; harness scheduler writes own markers)
    - `workspace/memory/YYYY-MM-DD*.md` → `<home>/agents/<agentId>/DailyNote_YYYY-MM-DD_HHMMSS.md`
- [ ] **Task 2.2: LanceDB Store Take-Over vs Guided Re-embedding**
  - Files: `packages/core/src/import/importers/openclaw-stores.ts`
  - Compares source store embedding identity against target harness embedding configuration:
    - **Match:** Copies LanceDB store partition directly (`copy-never-move`). Registers store in agent manifest.
    - **Mismatch:** Prepares guided re-embedding plan: creates staging generation, flags for background re-embedding migration.
  - Copies `.plur1bus-shared/` partitions and `.adaptive-learning/` audit logs verbatim.
- [ ] **Task 2.3: OpenClaw Cron & Channel Allowlist Mapping**
  - Files: `packages/core/src/import/importers/openclaw-channels.ts`, `openclaw-cron.ts`
  - Reads `channels.<platform>.allowFrom` from `openclaw.json` → harness bot-connection allowlists.
  - Reads `cron_jobs` table from `state/openclaw.sqlite`:
    - Maps user-authored jobs to `<home>/cron/jobs.json`.
    - Excludes managed jobs (`memory-core:*`, PLUR1BUS feature crons) per §2.2.
- [ ] **Task 2.4: Unit & Integration Tests**
  - Tests matching store takeover: data recalled without re-embedding; source remains byte-identical.
  - Tests mismatched store routing into re-embedding migration.
  - Tests D15 file mappings and cron exclusions.

---

### Batch 3: Hermes Importer (4–6 ad)

**Goal:** Implement the Hermes import pipeline (`importHermes`), taking over profiles, `§`-delimited memory cards, skills, approved pairings, and cron jobs.

- [ ] **Task 3.1: Profile Enumeration & Persona Scaffolding**
  - Files: `packages/core/src/import/importers/hermes-agents.ts`
  - Maps default profile and `profiles/<name>` to harness agents.
  - Copies `SOUL.md` per profile to `<home>/agents/<agentId>/SOUL.md`.
- [ ] **Task 3.2: Delimited Memory Migration to Memory Cards**
  - Files: `packages/core/src/import/importers/hermes-memories.ts`
  - Parses `memories/MEMORY.md` and `memories/USER.md` on `\n§\n` delimiter.
  - Generates memory cards with provenance `imported` and timestamps.
  - Writes to target agent's `memories.md` and `USER.md` and creates corresponding LanceDB card entries.
- [ ] **Task 3.3: Pairing Allowlists & Cron Mapping**
  - Files: `packages/core/src/import/importers/hermes-platforms.ts`, `hermes-cron.ts`
  - Scans `platforms/pairing/*-approved.json` → imports approved user IDs into channel allowlists.
  - Scans `platforms/pairing/*-pending.json` → explicitly **excludes** pending one-time codes (§3.2).
  - Reads `cron/jobs.json` → maps user jobs to harness cron jobs; preserves delivery targets.
- [ ] **Task 3.4: Optional Sessions Handling**
  - Reads `state.db` (when `--import-sessions` flag is present): maps sessions and message history, preserving `parent_session_id` lineage.
- [ ] **Task 3.5: Unit & Integration Tests**
  - Tests card splitting on `§` with correct provenance.
  - Tests pending pairings exclusion and approved pairings inclusion.
  - Tests idempotency and profile isolation.

---

### Batch 4: Cross-Cutting Pipeline, Ledger, Reports, Rollback & Wizard (2–3 ad)

**Goal:** Unify the importer pipeline with an atomic idempotency ledger, pre-apply snapshotting, full rollback, sanitized reports, secret leasing, and CLI/UI wizard exposure.

- [ ] **Task 4.1: Idempotency Ledger & Conflict Resolution**
  - Files: `packages/core/src/import/ledger.ts`, `conflicts.ts`
  - Computes entity idempotency keys (`agentId`, store hash, skill name/version, cron job hash, memory entry hash).
  - Progressively records applied writes to `<home>/imports/<runId>/ledger.jsonl`.
  - Implements conflict strategies: `skip` (default), `rename`, `replace`.
- [ ] **Task 4.2: Pre-Apply Snapshot & Rollback Engine**
  - Files: `packages/core/src/import/snapshot-target.ts`, `rollback.ts`
  - Snapshots target agent dirs, stores, skills, and config prior to apply.
  - Restores target state from snapshot upon `plur1bus import --rollback <report>`.
- [ ] **Task 4.3: Secret Store Leasing**
  - Files: `packages/core/src/import/secrets-lease.ts`
  - Leases allowlisted keys (`TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) only when `--migrate-secrets` is passed.
  - Never leaks secrets into reports or intermediate files.
- [ ] **Task 4.4: Report Generation & Sanitization**
  - Files: `packages/core/src/import/reports.ts`, `render.ts`
  - Emits JSON report conforming to `docs/import.md` §5.7 and human-readable text.
  - Automated assertions verify zero secrets, tokens, or content markers in report output.
- [ ] **Task 4.5: CLI Integration & UI Wizard Adapter**
  - Wire CLI arguments in Rust CLI and `import-bin.ts`.
  - Expose import endpoints for the desktop wizard.

---

## Verification & Acceptance Checklist

1. [ ] **Dry-Run Default:** A bare import invocation performs zero writes to source or target and returns a complete preview report.
2. [ ] **Byte-Identical Source:** Fixture source directories are bit-for-bit identical before and after import.
3. [ ] **Store Take-Over without Re-Embedding:** Matching embedding identity store (alpha, 384-d E5) is taken over directly without recomputing vectors.
4. [ ] **Guided Re-Embedding Routing:** Mismatched store (beta, 768-d NANO) is routed to re-embedding migration.
5. [ ] **Hermes Cards & Pairing:** `MEMORY.md` entries land with provenance `imported`; approved pairing lists are imported; pending pairing codes are excluded.
6. [ ] **Idempotency:** A second run against an imported target produces zero writes and reports `matched-existing` for all entities.
7. [ ] **Rollback:** `import --rollback` restores the pre-import target state completely.
8. [ ] **Zero Leaks:** Automated scans confirm no `FAKE_TOKEN` or `CONTENT_MARKER` appears in any report.
