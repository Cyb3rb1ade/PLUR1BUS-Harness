# Importers for OpenClaw and Hermes

**Status:** Phase 0 draft · **Date:** 2026-09-22 · **Depends on:** ADR-003 (agent model), ADR-007 (users/roles/identity) — written in parallel, referenced here by name only.

> **Amendment 2026-09-27 (owner, pulled forward):** two pieces of this importer ship ahead of M7 — the read-only **detect** step (`plur1bus import <openclaw|hermes> --detect`, §8) and the **skills import** (`plur1bus import <openclaw|hermes> --skills`, dry-run by default, `--apply` to write, `--rollback <report>`, §9). Everything else (stores, memory cards, soul, cron, channels, secrets, sessions, the wizard) stays in **M7** (`docs/milestones.md`). This resolves the old mismatch between the CLI stub ("M1b-3") and the milestone plan ("M7"): the stub label is gone, `plur1bus import` without `--detect`/`--skills`/`--rollback` answers `E_NOT_AVAILABLE` with `milestone: "M7"`. The reranker is now part of the detected configuration (§2.3.2).

Scope: `plur1bus-harness import <openclaw|hermes>` plus a UI wizard (auftrag §4.2, brief D2). This document is the source-format and mapping specification the importer implementation and its tests are built from. It does not specify the importer's internal code structure.

Sources opened for this document: `/home/claude/refs/openclaw` (`b9421f4`, v2026.9.5), `/home/claude/refs/hermes-agent` (`743ee72`), `/home/claude/refs/openclaw-plur1bus-memory` (`89148f9`, package `@cyb3rb1ade/plur1bus-memory` 7.15.4). Every path/schema claim below carries its own citation; claims not independently re-opened in this pass are marked "per research" and point at the underlying research file, which itself cites file:line.

---

## 1. Scope and principles

> **D28 (2026-09-25):** import is the one-time takeover of a legacy installation's data; it is not an operating mode. After a confirmed import with backup, the importer disables the PLUR1BUS plugin on that installation, because one store has exactly one engine owner (T7). A source system that keeps running and uses the harness as its memory attaches as a client instead and needs no import. No live installation is migrated before `docs/plugin-parity.md` is complete; the owner's VPS stays on the plugin until a test environment has proven the harness standalone and with attached systems.

From auftrag §4.2 (binding per brief §1, "everything not touched by D1–D11 remains binding"):

- `plur1bus-harness import <openclaw|hermes>`, callable multiple times, including after the harness is already in use.
- **Dry-run is the default.** Every invocation without an explicit apply flag only plans and reports.
- **Copy-never-move.** The source installation is never modified or deleted by the importer itself (mirrors PLUR1BUS's own `/share` semantics, §3 below).
- **Idempotent and resumable.** A second run against the same source, or a resumed run after interruption, converges to the same target state without duplicating entities.
- **Snapshot before applying.** A restorable backup of the harness-side target state is taken before any write.
- **Rollback.** A failed or unwanted apply can be reverted to the pre-import snapshot.
- **Source version detection.** The importer identifies the exact source format/schema version before planning, and refuses (with a named reason) rather than guessing when it cannot.
- **Conflict strategy:** skip / rename / overwrite-with-confirmation, chosen per entity or globally, never silently overwritten.
- **Report:** machine-readable (JSON) and a human-readable rendering of the same data, both **excluding content and secrets** — the report says what was found and what happened to it, never memory text, message bodies, or credential values.
- **Secrets are opt-in only, allowlist-based**, written directly into the harness secret store, never into the report or any intermediate file.
- **Tests against fixture installations** of both sources (§6).

### 1.1 Target model (harness-side)

| OpenClaw/Hermes source concept | Becomes in the harness | Notes |
|---|---|---|
| OpenClaw agent (`agentId`) / Hermes profile | A harness **agent**, identified by a PLUR1BUS `agentId` (ADR-003 defines the agent record; this importer preserves or maps the id, §2.3/§3) | One PLUR1BUS store per agent either way (auftrag §2.1: "Agent = PLUR1BUS-agentId") |
| OpenClaw workspace directory / Hermes profile home | A harness **workspace/project** binding for that agent (ADR-003's project concept, auftrag §7: "Projekt = PLUR1BUS-Workspace plus Arbeitsbereich") | Import creates the binding but not a full auftrag-§7 "project" (task board, notice board) unless one already existed source-side — there is no source-side equivalent to import |
| Source-side end user (chat user id, OS user) | A harness **principal** (ADR-007), linked to whatever channel identities the source recorded | Fail-closed: a source-side identity the importer cannot confidently bind to one principal becomes **no principal at all** rather than a guessed one (auftrag §4.2, §5.1) — see §2.4 |
| Bot token / channel account (Telegram, Discord, Slack, WhatsApp, Matrix …) | A harness **bot connection** entity (auftrag §8: "Bot-Verbindung … ist eine eigene Entität") bound to the target agent | Token itself is a secret (§5.5); the binding (channel + account id + allowlist) is not |
| Skill (`SKILL.md`) | A harness **skill**, installed per-agent from its manifest | Frontmatter fields (`name, description, version, author, license, platforms`) map directly (Hermes research Part B1, `skills/productivity/meeting-action-items/SKILL.md:1-16`) |
| Cron job (OpenClaw `cron_jobs` row, Hermes `jobs.json` record) | A harness **cron job** under the harness scheduler (brief D4/ADR-009), or archived for manual recreation when the source schedule shape has no confident mapping | See §4 (Hermes) and §2.2 (OpenClaw); feature/dreaming crons are never imported as generic jobs — the harness's own dreaming scheduler owns those (brief D4) |
| Memory card (MEMORY.md/USER.md entries, PLUR1BUS row) | A harness **memory card** with provenance `imported` (direct write, or via the review queue depending on the target agent's feature profile), landing in `memories.md` (long-term facts) or `knowledgepool.md` (knowledge-pool content) per the D15 (2026-09-22) file split — see §2.2/§3 rows below | §2.2 (OpenClaw — direct PLUR1BUS store take-over, not a card-by-card re-import) and §3 (Hermes — genuinely new cards) |
| PLUR1BUS store (LanceDB per agent, shared pools, journals, `.adaptive-learning`, tombstones, audit logs, Obsidian vault) | The harness's own PLUR1BUS store for that agent, taken over in place (no re-embedding) when the embedding identity matches, else migrated | §2.1 |

---

## 2. OpenClaw source

### 2.0 Source root per OS

From the plugin-distribution spec §B.1 (`docs/superpowers/specs/2026-09-28-plugin-distribution-and-migration-design.md`); the importer's resolution is §8.3, path mapping §8.6.

| Linux / macOS | Windows native | WSL-hosted, read from Windows | Windows-hosted, read from WSL |
|---|---|---|---|
| `$OPENCLAW_STATE_DIR` → `<home>/.openclaw-<profile>` → `<home>/.openclaw` → legacy `<home>/.clawdbot`; `<home>` = `$OPENCLAW_HOME` → `$HOME` → `os.homedir()` | the same, `<home>` = `%OPENCLAW_HOME%` → `%HOME%` (Git Bash) → `%USERPROFILE%` → `os.homedir()`: normally `C:\Users\<u>\.openclaw` | `--source \\wsl.localhost\<distro>\home\<u>\.openclaw` (or `\\wsl$\…`), incl. the Hub's `OpenClawGateway` distro; overrides set inside the distro are not seen until the M7 WSL probe | `--source /mnt/c/Users/<u>/.openclaw`; automatic discovery is M7 |

### 2.1 Version detection

| Signal | Value / format | Source | Use |
|---|---|---|---|
| `openclaw.json` `agents.defaults.workspace` and general JSON5 shape presence | JSON5 file at `~/.openclaw/openclaw.json`; "If the file is missing, OpenClaw uses safe defaults." | `docs/gateway/configuration.md:10` @ `b9421f4`, confirmed by direct read this pass | Presence + parseability is the first detection gate |
| Package/release version | `package.json` `"version": "2026.9.5"` (semver-by-date, no separate config-schema-version field found) | root `package.json` @ `b9421f4`; cross-checked, no internal schema-version scheme found anywhere in docs or code paths checked (openclaw-layout-dreaming-ui.md §1 Gaps) | Record the OpenClaw release string in the report; there is **no** internal config-schema version to gate on, unlike Hermes (§3) |
| State-directory layout marker | Presence of `state/openclaw.sqlite`, `agents/<agentId>/agent/openclaw-agent.sqlite`, `workspace/` under `~/.openclaw` or `$OPENCLAW_STATE_DIR` | `docs/openclaw-agent-runtime.md:47-59` @ `b9421f4`, confirmed by direct read this pass | Confirms "this is an OpenClaw state root," distinguishes current SQLite-auth layout from legacy |
| Legacy auth marker | A flat `auth-profiles.json` (pre-SQLite-auth) instead of `agents/<agentId>/agent/openclaw-agent.sqlite`; "Legacy `auth-profiles.json` files are no longer read at runtime; `openclaw doctor --fix` imports them into the SQLite store." | `docs/openclaw-agent-runtime.md:47-59` (same doc, same location) @ `b9421f4` | Signals an old install; the importer should read `auth-profiles.json` directly if present, since the running OpenClaw itself no longer does (this is the same file Hermes's own `hermes claw migrate` reads at `openclaw_to_hermes.py:1761`, confirmed §4) |
| Cron store schema | `cron_jobs` SQLite table (Kysely-typed `OpenClawStateKyselyDatabase["cron_jobs"]`) inside the shared state database | `src/cron/store/schema.ts:1,7-8` @ `b9421f4`, confirmed by direct read this pass — **resolves the "unconfirmed cron store format" gap in openclaw-layout-dreaming-ui.md §1** | Confirms cron jobs live in `state/openclaw.sqlite`, not a separate file; importer reads this table directly |

### 2.2 Directory table

All paths relative to `~/.openclaw` (or `$OPENCLAW_STATE_DIR`) unless noted.

| Path | Format | Schema/version | Source | Harness mapping | Secrets? |
|---|---|---|---|---|---|
| `openclaw.json` | JSON5 | no internal schema-version field (release-versioned only) | `docs/gateway/configuration.md:10,24` @ `b9421f4` | Split across agent config, channel bindings, model/provider config (rows below); values requiring secrets are separated out (§2.5) | Parts of it (see `env`/provider sub-objects below) |
| `state/openclaw.sqlite` | SQLite (`node:sqlite` + Kysely) | shared runtime state DB; includes `cron_jobs`, `cron_run_logs` tables (`src/state/openclaw-state-db.test.ts:7847,7916` confirm table names; production schema under `src/state/openclaw-state-db*.ts` @ `b9421f4`) | Table names confirmed by direct read this pass | `cron_jobs` rows → harness cron jobs (§2.2.1); other shared-state tables (routing, session bookkeeping) are host runtime state, not imported | No |
| `agents/<agentId>/agent/openclaw-agent.sqlite` | SQLite, per agent | "Per-agent model auth profiles (API keys + OAuth) and runtime state" | `docs/openclaw-agent-runtime.md:47-59` @ `b9421f4` | Auth-profile rows → harness secret store, opt-in only (§2.5); other runtime-state rows not imported | **Yes** (API keys, OAuth tokens) |
| `credentials/` | directory, format unconfirmed beyond "Provider/channel credentials outside the auth profile store" | n/a | `docs/openclaw-agent-runtime.md:47-59` @ `b9421f4` | Same opt-in secret path as `openclaw-agent.sqlite` | **Yes** |
| `agents/<agentId>/sessions/` | transcript history, format not enumerated in sources read | n/a | `docs/openclaw-agent-runtime.md:47-59` @ `b9421f4` | Optional, like Hermes sessions (§3): not imported by default; may contain pasted secrets or tool output — treat as sensitive-but-not-secret if ever offered | Possibly (message content) |
| `workspace/` or `workspace-<agentId>/` | directory tree (Markdown files + subdirs) | n/a | `docs/openclaw-agent-runtime.md:47-59`; default value example `agents.defaults.workspace: "~/.openclaw/workspace"` @ `docs/gateway/configuration.md:36-38` | Container for the memory files below | No (see individual files) |
| `workspace*/USER.md` | Markdown, optional | "stable preferences, communication style, relationships, and active-project context written as directives" | docs.openclaw.ai/concepts/memory (fetched 2026-09-22) | PLUR1BUS `user`-scope memory card content, provenance `imported`, landing in the target agent's harness-side `USER.md` curated file (D14) — but see §2.3: if a PLUR1BUS store already exists for this agent, the store take-over supersedes a card-by-card USER.md re-import | Possibly (user-authored, no credentials expected but audit) |
| `workspace*/MEMORY.md` | Markdown | "long-term memory. Durable non-profile facts and decisions" | docs.openclaw.ai/concepts/memory | → the harness's **`memories.md`** (D15, 2026-09-22 — supersedes the earlier `KNOWLEDGE.md` mapping), `agent-private`/workspace scope per source binding | Possibly |
| `workspace*/memory/YYYY-MM-DD.md` (or `-<slug>.md`) | Markdown, one file per day | "working layer: detailed daily notes, observations, session summaries, and raw context" | docs.openclaw.ai/concepts/memory | → the harness's **`DailyNote_YYYY-MM-DD_HHMMSS.md`** files (D15, 2026-09-22). Superseded by direct PLUR1BUS store take-over (§2.3) when a store exists; otherwise treated like Hermes daily-memory (§4 row `daily-memory`): merged into a target daily note | Possibly |
| `workspace*/DREAMS.md` (writer canonical name; reader also accepts `dreams.md`) | Markdown with managed blocks `<!-- openclaw:dreaming:{light,rem,deep,diary}:start/end -->` | n/a | `extensions/memory-core/src/dreaming-dreams-file.ts:12` @ `b9421f4`; managed-block markers confirmed in `openclaw-layout-dreaming-ui.md` §2 | Read-only reference material for the human; not merged into harness dreaming state — the harness's own dreaming scheduler (ADR-009) starts its own diary at **`dreaming.md`** (D15, 2026-09-22 — supersedes the earlier `DREAMS.md` mapping). Managed blocks are namespaced by phase already, so the source `DREAMS.md` can be copied verbatim alongside the new `dreaming.md` for historical reference without confusing the new scheduler, since the new scheduler writes its own distinct markers into its own file | No |
| `workspace*/memory/imports/{codex,claude-code,hermes}/` | Markdown, tool-namespaced | "kept separate from the bootstrap MEMORY.md rather than merged in" | docs.openclaw.ai/concepts/memory | Precedent the harness importer should follow for *its own* imports: land under a namespaced subdirectory/tag, never merged silently into the curated files (openclaw-layout-dreaming-ui.md §1 Inferences) | Possibly |
| `KNOWLEDGE.md` | Markdown | **not an OpenClaw-native file** — PLUR1BUS supplies it as a corpus supplement via `registerMemoryCorpusSupplement` | `/home/claude/refs/openclaw-plur1bus-memory/OPENCLAW_SDK_COMPAT_AUDIT.md:41`; not found in OpenClaw docs or repo grep (openclaw-layout-dreaming-ui.md §1) | → the harness's **`knowledgepool.md`** (D15, 2026-09-22). Treated as a PLUR1BUS store artefact (§2.3), not a separate OpenClaw source file — provenance unverified, see §7 | No |
| `skills/` — **exact default path unconfirmed** | directory of `SKILL.md`-bearing folders, or symlinked (example `~/.agents/skills/manager -> ~/path/to/skills`) | n/a | Config keys `skills.load.extraDirs`, `skills.allowBundled`, `skills.entries` confirmed at `docs/gateway/configuration-examples.md:228,283-293,434-467` @ `b9421f4` (direct read this pass); Skill Workshop's own write target confirmed as `<state-dir>/agents/<agentId>/agent/workshop-skills` (`configuration-examples.md:477`) | Enumerate `skills.load.extraDirs` from `openclaw.json` plus `<state-dir>/agents/<agentId>/agent/workshop-skills` (workshop-authored skills) as the two confirmed skill roots; a single fixed default directory (e.g. `~/.openclaw/skills`) was **not** found — see §7 | No (audit skill bodies for embedded credentials as precaution, per Hermes precedent §4) |
| `cron_jobs` table rows (in `state/openclaw.sqlite`) | SQLite rows via Kysely schema | n/a | `src/cron/store/schema.ts:1,7-8` @ `b9421f4`, confirmed this pass | Harness cron job per row, subject to the same archive-vs-live-map split as Hermes cron (§4, `cron-jobs` row) — OpenClaw's feature/dreaming crons (`memory-core` managed jobs) are excluded (see below) | No |
| Channel config and allowlists | inline in `openclaw.json`, `channels.<platform>.allowFrom` (array of ids/phone numbers), `channels.<platform>.groups` | n/a | `docs/gateway/configuration-examples.md:19,44-46,158-201,507-565` @ `b9421f4`, confirmed by direct read this pass — **resolves the "channel config file paths/allowlist format" gap** in openclaw-layout-dreaming-ui.md §1 | `allowFrom` arrays → harness bot-connection allowlists (safe, no secrets); channel account tokens live in the same `openclaw.json` `env`/provider sub-objects as chat-model keys, or in `credentials/` — gated as secrets (§2.5) | Allowlist: No. Tokens: Yes |
| Model/provider config | inline in `openclaw.json`, `agents.defaults.model`, `agents.entries.*.model.providers`, e.g. `model: { primary: "anthropic/claude-sonnet-4-6" }`, `providers: { "anthropic:default": { provider: "anthropic", mode: "api_key" } }` | n/a | `docs/gateway/configuration-examples.md:32,81-84,216,253,302-303,341-344` @ `b9421f4`, confirmed by direct read this pass | Provider **profile shape** (provider id, auth mode, base URL) → harness provider profile (ADR-006); the credential itself is a secret. **Anthropic `mode: "token"` (D12, 2026-09-22):** the owner's own production install carries a profile `anthropic:cyb3rb1ade-me.com` with `"mode": "token"` (`~/.openclaw/openclaw.json`, structure-only inspection, `research/verification-log.md` V9) — this maps onto the harness's new **"Anthropic setup-token"** provider profile (ADR-005 "Amendment D12"), `policy_status: restricted`, imported as **disabled until the operator opts in** to its risk notice, never auto-enabled by the importer; the token value itself follows the same opt-in, allowlist-gated secret path as any other credential (§5.6), never written to the report. OpenAI (`mode: "oauth"` ×2) and xAI (`mode: "oauth"`) profiles map the same way onto the harness's new `restricted` OpenAI/xAI OAuth profiles (D12); the `google-gemini-cli` `mode: "oauth"` profile maps onto the harness's Google Gemini-CLI (now Antigravity CLI `agy`, D40) OAuth profile, which stays `prohibited` and is imported **visible but disabled**, with no opt-in path, per §6.3 | Mode/shape: No. Key/OAuth token: Yes |

**Excluded from the generic cron import:** OpenClaw's own `memory-core` dreaming managed cron job (declaration key `memory-core:memory-dreaming-promotion`) and PLUR1BUS's eleven feature-cron specs (`persona-evolve`, `afterthought`, `consolidate-daily`, `auto-accept-stale`, `embedding-drain`, `emotion-refine`, `classify-recent`, `rem-dream`, `skill-miner`, `discover-semantic-links`, `gc-run`) are **not** imported as generic cron jobs — the harness's own dreaming scheduler (ADR-009) and feature-cron subsystem re-provision their own equivalents against the harness scheduler, never carrying over OpenClaw's or PLUR1BUS's job identifiers (`extensions/memory-core/src/dreaming-cron.ts:96-121` for the host job; `lib/setup/feature-cron-plan.js:25-170` for the PLUR1BUS jobs, per plur1bus-crons-embedding-portability.md §1). The importer's cron step therefore only processes user-authored `cron_jobs` rows that are not tagged as one of these managed families.

#### 2.2.1 `cron_jobs` row → harness cron job

Row fields were not individually enumerated from source in this pass (only the table's existence and location were confirmed, `src/cron/store/schema.ts:1,7-8`); mark the exact column list **unverified** pending a direct schema dump — flagged in §7. The importer's conflict/idempotency handling for this table follows the same pattern as Hermes `jobs.json` → harness cron (§4, `cron-jobs` row): import by field presence once the column list is confirmed, never assume forward-compatibility with a later OpenClaw release without re-checking.

### 2.3 PLUR1BUS stores — full artefact list and take-over rule

Auftrag §4.2: "**PLUR1BUS-Stores vollständig** übernehmen … Übernahme ohne Re-Embedding, wenn die Embedding-Identität erhalten bleibt; sonst geführte Re-Embedding-Migration."

| Artefact | Location (relative to `~/.openclaw` unless noted) | Source | Take-over rule |
|---|---|---|---|
| LanceDB per agent | `baseDbPath` default `~/.openclaw/memory` (sibling of `agents/`/`workspace/`, inside the OpenClaw state root, not inside it) | `openclaw-layout-dreaming-ui.md` §1, cross-checked against `/home/claude/refs/openclaw-plur1bus-memory/docs/configuration.md:57,112,122,143,149,169,209` | Copy the LanceDB directory as-is (copy-never-move) when the target embedding identity matches the stored one (§2.3.1); else feed it through PLUR1BUS's own re-embedding migration (target prepared → dry-run → copy into new generation → switch → old generation kept for rollback), per plur1bus-crons-embedding-portability.md §2 |
| Shared pools (`workspace`, `user` partitions) | `.plur1bus-shared/` under the workspace, populated only by `/share` | plur1bus-crons-embedding-portability.md §1 (`rem-dream` gap note: "shared workspace/user partitions read only `.plur1bus-shared/`") | Same take-over rule; each pool carries its own embedding identity independently (auftrag §6.2: "wählbar pro Agent/Store") |
| Journals / embedding cache | SQLite-backed embedding cache, columns `key_hash, provider, model, dimensions, scope_id, cache_version, text_hash, vector, debug_text, created_at, accessed_at, expires_at` | `lib/embedding-cache.js:57-58,216,485` @ `89148f9`, per plur1bus-crons-embedding-portability.md §2 | Copy verbatim; cache keys already include `dimensions`, so a mismatched-identity cache entry simply misses rather than corrupts anything — no migration needed for the cache itself, only for the vector store it accelerates |
| `.adaptive-learning/` (includes `acl-audit.jsonl`) | under the agent workspace | `lib/acl-middleware.js:183-215` @ `89148f9` (audit log path) | Copy verbatim (audit history); not re-interpreted by the importer |
| Tombstones | referenced by the `/forget` archive-first mechanism (auftrag §5: "`/forget` archive-first") — exact on-disk shape not opened in this pass | not independently confirmed this pass | Copy verbatim, unread by the importer; flagged in §7 as needing a direct schema check before the importer's test fixtures assert on tombstone content |
| Audit logs | `.adaptive-learning/acl-audit.jsonl` (ACL denials) and the separate destructive-op log via `appendDestructiveOpLog` (`lib/sql-safety.js:192`, body not read — plur1bus-crons-embedding-portability.md §3 Gaps) | `89148f9` | Copy verbatim; report only counts, never entries (report format, §5.6) |
| Obsidian vault | Vault directory referenced by `lib/obsidian-bridge.js`, `lib/obsidian/*` @ `89148f9` (paths not independently opened this pass) | plur1bus-crons-embedding-portability.md §4 (symlink-refusal citations touch `lib/obsidian/archive-rotation.js:68-75`, `lib/obsidian-bridge.js:1102,1120`) | Copy verbatim as a directory tree; the importer does not re-render or re-index it — PLUR1BUS's own vault watcher (`registerService`, per openclaw-layout-dreaming-ui.md §4) picks it up once the agent is running under the harness |
| `runs.json` | per-agent, `completed[runKey]` entries for rem-dream/reflection/compaction plus a 20-hour bootstrap-throttle marker | `lib/neo-arch.js:1916-1925` @ `89148f9`, per plur1bus-crons-embedding-portability.md §1 | Copy verbatim so the harness's re-provisioned feature crons see prior completion state and don't immediately re-run everything; **do not** copy the OpenClaw-plugin-version bootstrap marker itself, since the harness's provisioning path has a different identity and must run its own first-time reconciliation |

#### 2.3.1 Embedding identity match → take over without re-embedding

Embedding identity = model + revision/artefact hash + quantization + dimension + prefix/task schema + normalization + token cap (+ pinned upstream for aggregators), per auftrag §6.2, stored per store/generation. Confirmed composition mechanics (dimension validation, prefix/task-schema divergence between Jina v3 and v5, pinned per-file SHA-256 artefacts) at `lib/providers/dimensions.js:1-29`, `embedding-local-transformers.js:135-181,400-403`, `local-model-artifacts.js:18-113` @ `89148f9`, per plur1bus-crons-embedding-portability.md §2.

- **Match:** the importer runs PLUR1BUS's own compatibility probe (embed a fixed probe set, compare against stored reference vectors, per auftrag §6.2) against the target install's configured embedding provider. On match, the store directory is copied as-is (copy-never-move) and registered under the harness's agent record; no vectors are recomputed.
- **Mismatch (or target has no compatible provider configured yet):** the importer routes the store through PLUR1BUS's guided re-embedding migration — prepare target generation → dry-run → copy into new generation → separate switch → old generation retained for rollback (plur1bus-crons-embedding-portability.md §2, auftrag §6.2) — never a silent re-embed and never a mixed-vector-space table.
- A store whose embedding identity cannot be determined at all (e.g. missing/corrupt provider metadata) is treated as a mismatch, never as an assumed match.

#### 2.3.2 Reranker (added 2026-09-27)

The reranker was missing from this document. It touches **no stored vector** (ADR-006 §"Rerankers": switchable at runtime without migration), so a reranker difference is never a reason to re-embed or to block a take-over.

| Detected per source | Where | Values |
|---|---|---|
| Provider, model | PLUR1BUS plugin config `reranker.{enabled,provider,model,local.model,local.revision,local.dtype,fallbackProvider,fallbackModel}` (OpenClaw); Hermes has no reranker (`not-applicable`) | `provider` ∈ `local-transformers`, `cohere`, `disabled`; model id as configured, or the engine default (`woxpas-ai/bge-reranker-v2-m3-onnx` local, `rerank-v3.5` Cohere) marked `source: "engine-default"` |
| Local vs remote | from the provider | `local` (`local-transformers`), `remote` (`cohere`), `disabled` (`enabled: false` or provider `disabled`), `unknown` |
| Licence class | the pinned model catalog (ADR-006 table; `lib/providers/local-model-artifacts.js`) and the setup wizard's licence gate (ADR-006 "Non-interactive install … The same procedure applies to NC rerankers") | `permissive` (BGE-reranker-v2-m3, Apache-2.0), `non-commercial` (Jina reranker v2, CC BY-NC-4.0 — needs the owner's audit-logged NC confirmation before the harness may use it), `remote-service-terms` (hosted API, governed by the provider's terms, needs a provider key), `unknown` (a local model outside the catalog) |
| Scope | the plugin config is installation-wide; the source has no per-agent reranker override | one line `scope: "default"` (OpenClaw), none (Hermes) |

On import a reranker **mismatch is not fatal**: it becomes one report line with a recommendation (keep the harness default; or, for an NC model, run the licence gate first; or, for a remote reranker, note that the harness today forces a local reranker in `engine-config.ts` and remote rerankers need M2 provider profiles). Nothing is re-embedded and nothing is blocked because of it.

### 2.4 Workspace/user binding → harness principal (fail-closed)

Source-side identity fields: `channel`, `accountId`, `userId`, hashed as `userPrincipal = "user:v1:" + sha256([channel, accountId, userId])` (`lib/memory-request-context.js:300-306` @ `89148f9`, per plur1bus-crons-embedding-portability.md §3). Workspace identity: `workspace:v1:...` or a directory-derived `workspace-dir:v1:<canonicalDir>` fallback (`memory-request-context.js:27-28,173`).

| Binding present in source | Harness principal outcome |
|---|---|
| All three of `channel`/`accountId`/`userId` resolvable and stable | Bound to one harness principal per ADR-007's identity-linking model; the importer creates the link, an administrator or the user themself confirms it on first login (auftrag §5.1: "Zusammenführen nur mit Bestätigung") |
| Only a directory-derived `workspace-dir:v1:<canonicalDir>` identity (no channel/account/user triple) | Bound to the harness workspace/project, not to any human principal — this is workspace-scope memory, and stays workspace-scoped after import |
| Ambiguous, missing, or case/path-normalization-uncertain (e.g. `C:\Users\X` vs `c:\users\x` on a source captured pre-Windows-port, per plur1bus-crons-embedding-portability.md §4) | **Fail-closed: no principal created, no auto-merge.** The card/binding stays visible only to administrators as "unresolved source binding," never silently attached to an existing or guessed principal. This directly implements auftrag §4.2's "unklare Bindungen bleiben unsichtbar, fail-closed" |
| A channel the harness does not yet support (source channel outside the harness's channel list) | Same fail-closed outcome — the binding is recorded in the report as unmapped, not dropped and not guessed |

### 2.5 `agentId` preservation

| Case | Handling |
|---|---|
| Target harness install has no agent with this `agentId` yet | `agentId` preserved verbatim — the harness's own agent identity IS the PLUR1BUS `agentId` (auftrag §2.1: "Agent = PLUR1BUS-agentId"), so no re-keying is needed in the common case |
| Target already has a different agent using this `agentId` (e.g. re-importing into an install that already ran `plur1bus-harness agent create`) | Importer maintains an explicit **agentId mapping table** (source id → harness id) persisted alongside the import run record, so the mapping survives a second, resumed run (idempotency, §5) rather than being recomputed and risking a different collision resolution each time |
| Legacy pre-SQLite-auth OpenClaw install (`auth-profiles.json` present, no `openclaw-agent.sqlite`) | `agentId` still read from the directory structure (`agents/<agentId>/…`); the legacy auth file is read directly rather than assuming a live OpenClaw process will migrate it first (§2.1) |

### 2.6 Dreaming state handling

- `DREAMS.md` managed blocks (`<!-- openclaw:dreaming:{light,rem,deep}:start/end -->`) are copied verbatim into the new agent's workspace file for **human reference only**. The harness's own dreaming scheduler (ADR-009) never parses or continues these blocks; it starts its own diary with its own distinct marker set, so there is no risk of the new scheduler misinterpreting old entries as its own state (openclaw-layout-dreaming-ui.md §2).
- `runs.json` completion markers (§2.3, last row) are copied so PLUR1BUS's re-provisioned feature crons (`rem-dream`, `consolidate-daily`, etc., now running under the harness scheduler) see prior `completed[runKey]` state and skip immediate reruns of work already done pre-import, while the provisioning-bootstrap marker itself is **not** copied (the harness's provisioning path is a distinct identity and must reconcile fresh on first start).
- Legacy separately-scheduled dreaming jobs (`LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME`, `LEGACY_MEMORY_REM_DREAMING_CRON_NAME`, per openclaw-layout-dreaming-ui.md §2) are never imported as generic cron jobs, consistent with the exclusion in §2.2.

---

## 3. Hermes source

### 3.0 Source root per OS

| Linux / macOS | Windows native | WSL-hosted, read from Windows | Windows-hosted, read from WSL |
|---|---|---|---|
| `$HERMES_HOME` (expandvars + expanduser; `…/profiles/<name>` → its root, narrowed to that profile) → `~/.hermes` | `%HERMES_HOME%` → `%LOCALAPPDATA%\hermes` → `%USERPROFILE%\AppData\Local\hermes` | `--source \\wsl.localhost\<distro>\home\<u>\.hermes` | `--source /mnt/c/Users/<u>/AppData/Local/hermes` |

### 3.1 Version detection

| Signal | Value | Source | Use |
|---|---|---|---|
| Config schema version | `config.yaml` key `_config_version: 45` (current, "bump this when adding new required fields," not semver) | `hermes_cli/config_defaults.py:2607`, confirmed by direct read this pass | Read and record; the importer reads known keys by name rather than attempting a version-aware translation, since no changelog of what each of the ~45 bumps changed was reviewed (hermes-learnings-and-import.md Part B, B1) |
| Sessions DB schema version | `state.db` row `schema_version` / constant `SCHEMA_VERSION = 30` | `hermes_state_common.py:239`, confirmed by direct read this pass | Read the live `schema_version` row before importing; if it differs from 30, do not assume the field mapping in §3.2 still applies without re-checking `hermes_state_common.py`'s `SCHEMA_SQL` (Part B2) |
| FTS layout version | separate `fts_storage_version` marker, tracked independently of `schema_version` | `hermes_state_common.py` per Part B1 (line not independently re-opened this pass) | Informational only; sessions are optional to import (§3.2) |
| Root vs. named-profile markers | root markers `("config.yaml", ".env", "state.db")`; profile-identity markers `("config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db")` | `hermes_constants.py:200,279`, per Part B1 | Distinguishes the default profile (lives at `~/.hermes/` itself) from named profiles (`~/.hermes/profiles/<name>/`) |

### 3.2 Directory table

Paths relative to `~/.hermes` (`HERMES_HOME`; resolution order: context-local override → `HERMES_HOME` env var → `~/.hermes`, `hermes_constants.py:57,108-112`) for the default profile, or `~/.hermes/profiles/<name>/` for a named profile — both share the same internal shape.

| Path | Format | Schema/version | Source | Harness mapping | Secrets? |
|---|---|---|---|---|---|
| `SOUL.md` | Markdown, freeform | n/a | Part B1; migration target confirmed `openclaw_to_hermes.py:1273,1277` | → the target agent's **persona file** `SOUL.md` (auftrag §5: "Genau eine Soul pro Agent"; **kept, not renamed, by owner decision D14, 2026-09-22** — supersedes the earlier `persona.md` mapping) | No |
| `memories/MEMORY.md`, `memories/USER.md` | Markdown, entries delimited by `ENTRY_DELIMITER = "\n§\n"`; char limits `DEFAULT_MEMORY_CHAR_LIMIT=2200`, `DEFAULT_USER_CHAR_LIMIT=1375` | n/a | `optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py:30-32` (constants confirmed by direct read this pass), `1020-1030`; addressing `agent/learning_mutations.py:4-16` | Parsed on the `§` delimiter into discrete entries → PLUR1BUS memory cards, provenance `imported`, `MEMORY.md` entries landing in the harness's **`memories.md`** (D15, 2026-09-22) and `USER.md` entries in the harness's **`USER.md`** curated file (D14). Landing is **direct** into the store for a `safe` feature profile, or via the review queue when the target agent's feature profile requires review before durable writes (auftrag §5: "kuratierte Dateien … wie heute unter OpenClaw"; feature-profile safe/recommended split, auftrag §4.1) | Possibly (user-authored; audit for pasted secrets, no credentials expected by design) |
| `skills/<category>/<name>/SKILL.md` | YAML frontmatter (`name, description, version, author, license, platforms, metadata.hermes.{tags,related_skills}`) + Markdown body | no independent schema-version field | `skills/productivity/meeting-action-items/SKILL.md:1-16`, per Part A9/B1 | → harness skill, frontmatter fields preserved verbatim (including `related_skills` cross-references) | No (audit bodies as precaution) |
| `skills/.curator_state` | JSON, per-skill lifecycle timestamps | n/a | `agent/curator.py:38-39`, per Part A9 | Not imported — curator lifecycle state is Hermes-internal bookkeeping with no harness equivalent; the harness's own skill-miner queue (auftrag §4.1) starts fresh | No |
| `cron/jobs.json` (root profile) or `profiles/<name>/cron/jobs.json` | single JSON file, all cron job definitions for the profile, guarded by advisory locking (`fcntl` POSIX / `msvcrt` Windows) | no explicit version field observed | `cron/jobs.py:1,63-74,110`, per Part B1/B2 | → harness cron job per record, subject to the archive-vs-live-map policy in §4 (`cron-jobs` row); the exact per-record field shape was **not read** in this pass (flagged §7) | Possibly (job prompt text may reference sensitive context — audit, not blanket-excluded) |
| `platforms/pairing/{platform}-pending.json` | JSON, one-time codes, 1-hour expiry, chmod 0600 | n/a | `gateway/pairing.py:1-9,321-345` (docstring + `PairingStore` confirmed by direct read this pass); actual storage subpath confirmed as `platforms/pairing` via `get_hermes_dir("platforms/pairing", "pairing", …)` at `gateway/pairing.py:328-329` | **Excluded from import.** Active one-time codes are security-sensitive and expire within an hour regardless — importing them would just create dead, never-redeemable codes; there is no benefit and a (small) leak surface | Sensitive, excluded |
| `platforms/pairing/{platform}-approved.json` | JSON, `{user_id: {user_name, approved_at}}` | n/a | `gateway/pairing.py:388-394,427-428`, confirmed by direct read this pass | **Imported.** This is exactly the "allowlists and approved pairings" the auftrag asks for — maps to the harness bot-connection allowlist for the corresponding channel. Contains only user id + display name + timestamp, no secrets | No |
| `platforms/pairing/_rate_limits.json`, `_declined.json` | JSON | n/a | `gateway/pairing.py:351,354` | Not imported — rate-limit/decline history is operational noise with no equivalent harness concept, and would not improve or worsen anything if dropped | No |
| `state.db` | SQLite, `SCHEMA_VERSION = 30` | see §3.1 | `hermes_state_common.py:239`, table names confirmed by direct read this pass (`schema_version`, `system_prompts`, `sessions`, `messages`, `session_model_usage`, `state_meta`, plus gateway/lock bookkeeping tables) | **Sessions are optional**, per auftrag §4.2 ("Sessions optional"). If offered: `sessions`/`messages`/`session_model_usage` map field-for-field into the harness's own session store, preserving the `parent_session_id` compaction-lineage chain if the harness wants equivalent "show me what this was compacted from" UX (Part A1). Read `schema_version` first (§3.1) | **Yes for message content** — `content`, `tool_calls`, and `system_prompt` text may contain pasted secrets or credential-bearing tool output; gate behind the same explicit opt-in as `.env` (auftrag: "nie im Klartext … in … Exporten"), separately from the "sessions optional" toggle itself |
| `config.yaml` | YAML | `_config_version: 45` | `hermes_cli/config_defaults.py:2607`; memory-related keys at `tools/memory_tool.py:229-232` | Read known keys by name (`memory_enabled`, `user_profile_enabled`, provider/model selection, command-allowlist patterns) into the corresponding harness config surfaces | Mixed — most keys safe, provider key *values* (if inlined rather than referencing `.env`) are secrets |
| `.env` | dotenv `KEY=value` | n/a | Referenced in `openclaw_to_hermes.py:1418-1419`, per Part B1 | **Not imported by default.** Opt-in only, allowlisted (§5.5) | **Yes — the secrets file** |

Foreign memory-provider data (any external `MemoryProvider` ABC implementation other than Hermes's built-in file-backed memory — e.g. a third-party provider like the ones referenced in Part A4) is **excluded**: it has no PLUR1BUS-shaped equivalent, and the auftrag is explicit that "Daten fremder Memory-Provider werden nicht übernommen" (§4.2).

### 3.3 Profiles → agents

Each Hermes profile (`~/.hermes/` root = the `default` profile, `~/.hermes/profiles/<name>/` = a named profile — both sharing the same internal shape, `hermes_constants.py:200,279`) is enumerated as an independent import source and becomes one harness agent, carrying its own `SOUL.md`, memory files, skills, cron jobs, and platform config exactly as if it were a standalone installation (Part B1: "treat each as an independent 'installation' for import purposes").

---

## 4. Reuse of `hermes claw migrate`

`hermes claw migrate` (CLI: `hermes_cli/claw.py`, 526 lines; mapping logic: `optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py`, 3,246 lines) migrates **OpenClaw → Hermes**, the opposite direction of this importer's OpenClaw path, but its policy decisions and its 31-row source→destination table (`MIGRATION_OPTION_METADATA`, confirmed as 35 individual option kinds collapsed into 31 table rows by combining `skills`/`shared-skills` and the `browser-config`/`tools-config`/`approvals-config` and `ui-identity`/`logging-config` groups — counted by direct read this pass, `openclaw_to_hermes.py:47-188`, `189-226`) are directly reusable as **OpenClaw → harness** mappings, since both are "leave OpenClaw, land somewhere PLUR1BUS-shaped" migrations reading the same OpenClaw source paths.

### 4.1 Reusable mappings

| Migration option kind(s) | OpenClaw source | file:line | Reusable as OpenClaw→harness mapping? | Reasoning |
|---|---|---|---|---|
| `soul` | `workspace/SOUL.md` or `workspace.default/SOUL.md` | `openclaw_to_hermes.py:1273,1277` | **Yes, directly** — but see note | OpenClaw persona is the harness agent's persona file `SOUL.md` (auftrag §5; **kept, not renamed — D14, 2026-09-22**). Skip Hermes's own `rebrand_text` product-name substitution — the harness has no reason to rewrite persona text |
| `workspace-agents` | workspace `AGENTS.md` | `openclaw_to_hermes.py:46,1290-1291` | Yes | Direct copy, same reasoning |
| `memory`, `user-profile`, `daily-memory` | `workspace*/MEMORY.md`, `USER.md`, `workspace/memory/*` | `openclaw_to_hermes.py:1020-1021,1029-1030,2036` | **No, superseded** by direct PLUR1BUS-store take-over (§2.3) when a store already exists for the agent. Reused only as the fallback path when no PLUR1BUS store is found (a bare OpenClaw install with no PLUR1BUS plugin ever enabled) | The OpenClaw→harness importer has a strictly better source of truth (the LanceDB store itself) than re-parsing Markdown on the `§`-delimiter convention Hermes invented for its own file format — that delimiter doesn't even apply to OpenClaw's own MEMORY.md shape |
| `command-allowlist` | `exec-approvals.json` | `openclaw_to_hermes.py:1338-1397` | Yes | Policy patterns, not secrets; merge-don't-overwrite policy reused directly |
| `messaging-settings`, `discord-settings`, `slack-settings`, `whatsapp-settings`, `signal-settings` | `openclaw.json` per-channel sections | `openclaw_to_hermes.py:1479-1503,1582-1584,1603-1605,1618-1620,1639-1646` | Yes, for the allowlist/config half; token half stays secret-gated | Matches §2.2's own channel-config row; Hermes's split (allowlist safe, token gated) is exactly the split this importer already specifies |
| `secret-settings`, `provider-keys` | `openclaw.json` allowlisted secret keys; `agents/main/agent/auth-profiles.json` | `openclaw_to_hermes.py:1540-1544,1727-1790` | Yes, **including the gating policy** | "Secrets always require a second explicit flag regardless of preset" (§5.5) is adopted verbatim, and `auth-profiles.json` is exactly the legacy OpenClaw auth file identified in §2.1/§2.5 |
| `model-config`, `tts-config`, `full-providers`, `browser-config`, `tools-config`, `approvals-config` | `openclaw.json` respective sections | `openclaw_to_hermes.py:1799-1864,1868-1964,152-155,160-171` | Yes | Simple scalar/section copies with conflict detection; no structural incompatibility with a harness config surface |
| `tts-assets` | workspace TTS asset files | option `openclaw_to_hermes.py:80-83` | Yes, if the harness ships TTS at all (out of scope for Phase 0) | No secrets expected |
| `skills`, `shared-skills` | per-workspace and shared `SKILL.md` trees | `openclaw_to_hermes.py:1969-2008,2098-2163` | Yes, **including the three-way conflict mode** (`skip`/`overwrite`/`rename`, `SKILL_CONFLICT_MODES`, confirmed at `openclaw_to_hermes.py:37` by direct read this pass) | Directly reusable as the importer's own skill-conflict policy (§5.3) |
| `mcp-servers` | `openclaw.json` MCP server definitions | option `openclaw_to_hermes.py:124-127` | Conditionally — structurally safe to map, but **audit each server's command/env fields for embedded keys before treating as non-secret** (Hermes's own importer does not confirm it redacts these; unverified per Part B3) | Same caution the research flagged; the harness importer should not assume Hermes-side precedent covers this without its own explicit check |
| `agent-config`, `gateway-config` | `openclaw.json` agent defaults / gateway port+auth | option `openclaw_to_hermes.py:140-147` | Yes, for the scalar-default half; archive the structural half (multi-agent list, full gateway config) | Matches the split Hermes itself applies — adopt the split, not just the destination |

### 4.2 Archive-for-manual-review policy

Hermes's importer **archives rather than live-imports** structurally incompatible config: `plugins-config`, `cron-jobs` (the schedule *definitions* — see below), `memory-backend`, `session-config`, `hooks-config`, `deep-channels` (partially), `skills-config`, `ui-identity`, `logging-config`, plus a catch-all `archive` option for anything else compatible-but-unmapped (`openclaw_to_hermes.py:2338-2382`, options described at `:120-187`, per Part B3).

**Adopted for the OpenClaw→harness importer, with reasoning per item:**

| Source config | Adopt archive-first? | Reasoning |
|---|---|---|
| `plugins-config` (`openclaw.json` `plugins.*` + `extensions/`) | **Adopt.** | OpenClaw plugin config has no structural equivalent in the harness's own plugin model (auftrag §8: Hermes-Plugin-API, trust model, opt-in). Auto-mapping risks silently misconfiguring a harness plugin that only superficially resembles the OpenClaw one. Archive for manual review, exactly Hermes's own precedent |
| `cron-jobs` (schedule *definitions*, not the plain user-authored `cron_jobs` rows already handled in §2.2/§2.2.1) | **Adopt for feature/dreaming-family jobs; do not adopt for plain user-authored jobs.** | Feature and dreaming crons are explicitly excluded from generic import already (§2.2) — the harness re-provisions its own. Plain user cron jobs (arbitrary schedule + prompt) are *not* archived: their column shape, once confirmed (§7), is simple enough to live-map directly, unlike Hermes's `deliver=<platform>` chat-delivery routing which does need re-mapping onto the harness's own delivery-target vocabulary (Part B1 cron row) |
| `memory-backend` (OpenClaw memory backend settings, e.g. QMD/vector search/citations config outside PLUR1BUS) | **Adopt.** | The harness has exactly one memory backend (PLUR1BUS, auftrag §2.1: "kein austauschbares Memory-Backend") — there is nothing to map an alternate backend's config *onto*. Archive for the operator's own reference, never auto-applied |
| `session-config` (advanced session timers etc.) | **Adopt.** | Timer semantics are not guaranteed to map 1:1 onto the harness's own session model; same reasoning Hermes gives for not translating them itself |
| `hooks-config` (webhooks, Gmail integration) | **Adopt.** | No confirmed harness equivalent surface in Phase 0 scope |
| `deep-channels` (Matrix/Mattermost/IRC extended settings) | **Adopt, partially** — safe scalar fields (base URL, room id) can live-map; complex per-platform structural blocks archive | Matches Hermes's own "partially imported / partially archived" treatment |
| `skills-config` (per-skill enabled/config/env) | **Adopt.** | Skill *files* are live-imported (§2.2, §4.1); their enable/config state is deliberately archived so the harness's own skill-activation flow (with its "preview before activation" step, auftrag §8) is the source of truth post-import rather than a silently-carried-over on/off state |
| `ui-identity`, `logging-config` | **Adopt.** | Cosmetic/operational, no confident mapping benefit vs. translation risk |
| Catch-all `archive` for anything else | **Adopt.** | Directly reusable as the importer's own least-surprise default: anything without a confident mapping is archived for manual review, never silently dropped or force-mapped |

No item from Hermes's archive-first list is rejected outright — the policy transfers because the underlying reasoning (structural incompatibility, timer/schedule semantics that don't guarantee 1:1 translation, "the harness already has exactly one X so there's nothing to map onto") applies equally to an OpenClaw→harness path.

---

## 5. Process

### 5.1 Phases

`detect → snapshot → plan → dry-run report → apply → verify → report`

1. **Detect:** identify source type (OpenClaw/Hermes), confirm version markers (§2.1/§3.1), enumerate profiles/agents found. Refuses with a named reason if the source cannot be confidently identified (no silent "assume OpenClaw" fallback).
2. **Snapshot:** back up the harness-side target state (PLUR1BUS stores and vault first, then config/users/sessions — auftrag §11 backup ordering) before any write. The snapshot is what rollback (§5.4) restores.
3. **Plan:** build the full entity list (agents, memory cards or stores, skills, cron jobs, channel bindings, provider config) with a proposed action per entity (create / skip / rename / overwrite-pending-confirmation / archive), using the mapping tables in §2/§3/§4.
4. **Dry-run report:** the plan rendered as the report (§5.6) — this is what a bare `import` invocation without an apply flag stops at, matching "Dry-Run als Default."
5. **Apply:** execute the plan. Copy-never-move throughout; each entity write is individually idempotent (§5.2) so a resumed apply after interruption re-applies safely.
6. **Verify:** re-read what was written (readback), confirm PLUR1BUS store compatibility probes passed (§2.3.1) where relevant, confirm secret-store writes succeeded without ever having touched the report.
7. **Report:** final JSON + human-readable rendering (§5.6), reflecting what actually happened (including any entities that failed and were skipped, with reasons), never a re-statement of the dry-run plan as if it were the outcome.

### 5.2 Idempotency keys

Reusing PLUR1BUS's own idempotency pattern (`/share`'s `idempotencyKey = hash([action, targetScope, principal, sourceAgent, source.id, hash(text)])`, `shared-memory.js:213-232` @ `89148f9`, per plur1bus-crons-embedding-portability.md §3):

| Entity | Idempotency key | Effect of re-running |
|---|---|---|
| Agent | source `agentId` (or Hermes profile name) + source type | Existing agent recognized, not recreated; the `agentId` mapping table (§2.5) is consulted |
| PLUR1BUS store take-over | store directory path + embedding-identity fingerprint | A store already taken over is not re-copied; a store already migrated to a new generation is not re-migrated |
| Skill | skill manifest `name` + `version` + source | Matches the skill-conflict policy (§4.1, §5.3) rather than creating a duplicate |
| Cron job | source job id (or a hash of its schedule+prompt when the source has no stable id) | Re-run recognizes the existing harness job and does not duplicate it |
| Channel/bot-connection allowlist entry | (channel, source user id) | Merge, never duplicate |
| Memory card (Hermes path, §3.2) | hash of the card's source entry text + source file + source profile | A card already imported is not re-inserted; this mirrors Hermes's own entry-level dedup in its migrator (`openclaw_to_hermes.py:1304-1320`) |

### 5.3 Resumability

Each apply-phase write is committed with its idempotency key recorded in the import run's own ledger (a harness-side record, not written into the source) before moving to the next entity. An interrupted apply (crash, kill, network loss to the harness API) resumes by re-running the plan and skipping every entity whose idempotency key is already present in the ledger — this is the same mechanism idempotency (§5.2) already provides, so resumability requires no separate design, only that the ledger is durable and consulted before every write.

### 5.4 Conflict strategy per entity type

| Entity type | Conflict strategy |
|---|---|
| Skill | skip / rename / overwrite, reusing `SKILL_CONFLICT_MODES` from `hermes claw migrate` verbatim (§4.1) |
| Agent (`agentId` collision) | never silently overwritten — resolved via the mapping table (§2.5), operator confirms which wins if both are non-trivial |
| PLUR1BUS store | never overwritten in place — a conflicting existing store for the same agent blocks the plan until the operator chooses which store is authoritative (this is a data-loss-risk case, always confirmation-gated) |
| Memory card (Hermes path) | merge with dedup on entry-hash (§5.2); true content conflicts (same logical entry, different text) are surfaced for confirmation, never silently overwritten |
| Cron job | skip if an equivalent job already exists (same idempotency key); rename (new job id, both kept) or overwrite-with-confirmation otherwise |
| Channel allowlist entry | merge (union); never a destructive conflict — an allowlist entry disappearing is a security-relevant deletion and is never inferred from an import diff |

### 5.5 Rollback

The pre-apply snapshot (§5.1 step 2) is the rollback target. Rollback restores the harness-side PLUR1BUS stores, vault, config, users, and sessions to their pre-import state; it never touches the source installation (which was never modified — copy-never-move). Rollback is itself dry-run-previewable before being applied, consistent with the rest of the importer's default posture.

### 5.6 Secrets handling

Opt-in only, allowlist-based, written directly to the harness secret store, never into any report or intermediate file (auftrag §4.2, §6.3: "Secrets nur Opt-in, allowlist-basiert … nie in Klartext").

**Allowlist, following Hermes's own precedent** (`SUPPORTED_SECRET_TARGETS`, `openclaw_to_hermes.py:38-45`, confirmed by direct read this pass):

```
TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY,
ELEVENLABS_API_KEY, VOICE_TOOLS_OPENAI_KEY
```

Extended for the harness's own provider matrix (ADR-006) with the equivalent env-var names for every chat/embedding/rerank provider the harness ships a profile for (Google AI, xAI, OpenRouter, Cohere, Jina, Voyage, etc.) — the exact extended list is an ADR-006/provider-matrix.md deliverable, not duplicated here; this document fixes the *policy* (allowlist, opt-in, never in the report), not the final list.

- `--migrate-secrets` (or the harness's own equivalently-named flag) is required **in addition to** whichever apply mode is chosen — never implied by "apply everything" alone, matching `hermes claw migrate`'s "secrets always require a second explicit flag regardless of preset" (§4.1).
- Values matched to an allowlisted name are leased into the harness secret store (OS keychain / encrypted file fallback, per auftrag §6.3) immediately; the importer holds them in memory only for the duration of that write.
- Any key/value pair encountered outside the allowlist (an unrecognized env var, an MCP server's env block, a provider config's inline header) is **never imported automatically** — it is named (key only, never its value) in the report as "found, not imported, add manually if needed."

### 5.7 Report format

**JSON schema sketch** (excludes content and secret values everywhere; counts and identifiers only):

```json
{
  "importId": "uuid",
  "sourceType": "openclaw | hermes",
  "sourceVersion": "string (release string or config/schema version)",
  "mode": "dry-run | apply",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "profilesOrAgents": [
    {
      "sourceId": "string",
      "harnessAgentId": "string",
      "action": "created | matched-existing | skipped | conflict-pending",
      "plur1busStore": {
        "found": true,
        "embeddingIdentityMatch": true,
        "action": "taken-over | re-embedding-migration | none"
      },
      "counts": {
        "memoryCardsImported": 0,
        "memoryCardsSkippedDuplicate": 0,
        "skillsImported": 0,
        "skillsConflicted": 0,
        "cronJobsImported": 0,
        "cronJobsArchived": 0,
        "allowlistEntriesImported": 0,
        "sessionsImported": 0
      }
    }
  ],
  "secrets": {
    "opted_in": false,
    "allowlistedKeysImported": ["TELEGRAM_BOT_TOKEN"],
    "foundNotImported": ["SOME_UNKNOWN_KEY"]
  },
  "unresolvedBindings": [
    { "sourceRef": "string", "reason": "ambiguous-channel-identity | unsupported-channel | case-normalization-uncertain" }
  ],
  "archived": [
    { "kind": "plugins-config | cron-jobs-feature-family | memory-backend | ...", "path": "archive/relative/path" }
  ],
  "errors": [ { "sourceRef": "string", "reason": "string" } ]
}
```

**Human-readable rendering:** the same document as a short narrative + tables per agent/profile (counts, not content), an "unresolved bindings — needs a human" section, an "archived for manual review" section, and a "secrets: N found, M imported (opt-in), K found-not-imported (add manually)" summary line. Never lists memory-card text, session message content, or any secret value, matching the JSON schema's own exclusions.

### 5.8 Audit entries

Every apply-phase write appends one audit entry (auftrag §11: "Audit-Trail … für … Importe"), structured like PLUR1BUS's own destructive-op and ACL audit logs (`appendDestructiveOpLog`, `lib/sql-safety.js:192`; ACL audit `lib/acl-middleware.js:183-215`, both @ `89148f9`): `{timestamp, actorUserId, importId, entity, action, outcome}`. Audit logging must never itself fail the import (same "audit logging must never crash the application" principle PLUR1BUS states for its own ACL audit, `acl-middleware.js` per plur1bus-crons-embedding-portability.md §3) — a failed audit write is itself logged and reported, but does not block or roll back the underlying import step.

---

## 6. Test plan

### 6.1 Fixture installations

**OpenClaw fixture** must contain, entirely synthetic (no real user data, per auftrag "niemals … echte Nutzerdaten … in … Test-Fixtures"):

- A minimal `openclaw.json` (JSON5) with `agents.defaults.workspace`, one channel section with a fake `allowFrom` entry, one provider profile with a placeholder (non-functional) API key.
- `state/openclaw.sqlite` with the `cron_jobs`/`cron_run_logs` schema (`src/state/openclaw-state-db.test.ts:7847,7916` gives the exact `CREATE TABLE` shape to replicate) populated with 1–2 synthetic user-authored jobs and one synthetic `memory-core` managed job (to exercise the exclusion rule, §2.2).
- `agents/<agentId>/agent/openclaw-agent.sqlite` with a placeholder auth-profile row (fake key value, clearly marked as a fixture, e.g. `sk-fixture-not-real`).
- `workspace/` with synthetic `SOUL.md`, `MEMORY.md`, `USER.md`, `memory/2026-01-01.md`, `DREAMS.md` (containing one of each managed-block phase marker), and a `skills/` subtree with one fixture `SKILL.md`.
- A PLUR1BUS store fixture with **two distinct embedding identities** (§6.3) to exercise both the take-over and the re-embedding-migration paths in one test run.
- A legacy-layout variant (flat `auth-profiles.json`, no `openclaw-agent.sqlite`) to exercise §2.1/§2.5's legacy handling.

**Hermes fixture** must contain, entirely synthetic:

- `config.yaml` with `_config_version: 45` and a `memory:` section with placeholder limits.
- `state.db` built from the confirmed schema (`hermes_state_common.py:328-540` table list) with `schema_version = 30`, 1–2 synthetic sessions with a `parent_session_id` chain (to test lineage preservation) and synthetic, clearly-fake message content.
- `SOUL.md`, `memories/MEMORY.md` and `memories/USER.md` with a handful of `§`-delimited synthetic entries.
- `skills/<category>/<name>/SKILL.md` with full frontmatter fields.
- `cron/jobs.json` with 1–2 synthetic job records (one plain, one `deliver=<platform>`).
- `platforms/pairing/telegram-approved.json` with 1–2 synthetic `{user_id: {user_name, approved_at}}` entries, plus a `telegram-pending.json` with an unexpired fixture code (to test the exclusion rule, §3.2).
- A `.env` with placeholder allowlisted keys (e.g. `TELEGRAM_BOT_TOKEN=fixture-not-real`) to test the opt-in secrets gate without any real credential ever existing in the repo.
- A second profile under `profiles/<name>/` with its own minimal shape, to test the "each profile is an independent import source" rule (§3.3).

**Generating fixtures without real data:** hand-author every fixture file directly (JSON5/YAML/Markdown/SQLite `CREATE TABLE` + `INSERT` with synthetic values) rather than exporting from any real installation; SQLite fixtures are built via a small script that executes the confirmed `CREATE TABLE` statements and inserts clearly-fake rows, checked into the test suite as fixture-generation code (not as a committed binary DB file) so the schema stays traceable to its source citation.

### 6.2 PLUR1BUS store fixture with two embedding identities

Build two small LanceDB stores (few rows each) using two different pinned local models from the confirmed catalog (`lib/providers/dimensions.js:1-29` @ `89148f9`): e.g. `intfloat/multilingual-e5-small` (384-d) for one agent's store and `jinaai/jina-embeddings-v5-text-nano-retrieval` (768-d) for another. Each store's embedding-identity metadata (model + revision + dimension + prefix/task schema) is recorded exactly as PLUR1BUS itself records it, so the compatibility probe (§2.3.1) can be exercised against both a matching and a mismatched target-provider configuration in the same test run — one store take-over should succeed without re-embedding, the other should be routed into the guided re-embedding migration path.

### 6.3 Acceptance (from original M7)

Per auftrag §12 M7: *"OpenClaw-Installation mit PLUR1BUS-Stores — Dry-Run-Bericht, dann Übernahme ohne Re-Embedding, alte Erinnerungen werden erinnert, Quelle unverändert; Hermes-Profil — Soul, Skills, Cron übernommen, `MEMORY.md`-Einträge als Karten mit Herkunft; zweiter Lauf ist idempotent."*

Acceptance tests, directly against the fixtures above:

1. Dry-run against the OpenClaw fixture produces a report matching the JSON schema (§5.7) with no writes to either source or target.
2. Apply against the OpenClaw fixture (matching-identity store) takes the store over without re-embedding; a recall against the imported agent returns pre-import memories; the source fixture directory is byte-identical before and after (copy-never-move verification).
3. Apply against the Hermes fixture imports Soul, skills, and cron jobs; `MEMORY.md`/`USER.md` entries land as memory cards with provenance `imported`.
4. A second run of either apply (unmodified fixture, unmodified target) produces zero new writes and a report showing every entity as `matched-existing` — the idempotency acceptance criterion.
5. The mismatched-identity store in the two-identity fixture (§6.2) is routed into re-embedding migration, never silently mixed into the matching store's vector space.
6. Rollback after an apply restores the pre-apply harness state exactly (verified by re-running the dry-run report and diffing against the original).

---

## 7. Gaps

| Gap | What's missing | Where to verify |
|---|---|---|
| OpenClaw skills default directory | **Resolved 2026-09-27 (§8.4):** the loader (`src/skills/loading/workspace-skill-sources.ts` @ `b9421f4`) reads `skills.load.extraDirs`, plugin skill roots, the bundled dir, `<agentDir>/workshop-skills`, the managed `<state-dir>/skills`, `~/.agents/skills` (default state dir only), `<workspace>/.agents/skills` and `<workspace>/skills`. Original text: No single fixed default directory was found (only `skills.load.extraDirs` config and the Skill Workshop's own `<state-dir>/agents/<agentId>/agent/workshop-skills` write target, both confirmed §2.2). Whether OpenClaw also has an implicit `~/.openclaw/skills` default alongside these was not confirmed by a source read that opened the skills-loading code path itself. | Read `src/skills/` loader source directly (not just `docs/gateway/configuration-examples.md`) in `/home/claude/refs/openclaw` before the importer implementation assumes a fixed default path. |
| OpenClaw `cron_jobs` table column shape | Table's existence and location confirmed (`src/cron/store/schema.ts:1,7-8`), but the actual column list (job id, schedule expression, prompt/command, delivery target, enabled flag, etc.) was not read this pass. | Read `src/cron/store/schema.ts` in full plus the migration files under `src/state/openclaw-state-db-schema-*.ts` in `/home/claude/refs/openclaw` for the authoritative column list before finalizing §2.2.1 and the fixture's `CREATE TABLE` statement. |
| `KNOWLEDGE.md` provenance | Confirmed as a PLUR1BUS-supplied corpus supplement (`registerMemoryCorpusSupplement`), not an OpenClaw-native file — but the PLUR1BUS-side source (`OPENCLAW_SDK_COMPAT_AUDIT.md:41`) was not independently re-opened in this pass; its exact on-disk location and format within a PLUR1BUS store were not confirmed. | Open `/home/claude/refs/openclaw-plur1bus-memory` for `registerMemoryCorpusSupplement` call sites and the corpus-supplement's on-disk path before the importer's §2.3 store take-over enumerates it explicitly rather than treating it as "whatever is in the store directory already." |
| Hermes `cron/jobs.json` record shape | Store path and locking mechanism confirmed (`cron/jobs.py:1,63-74,110`); the actual per-job JSON record fields (schedule expression format, `deliver=<platform>` field name, prompt field name) were not read in this pass (Part B, Verification notes). | Read `cron/jobs.py` and its schema/dataclass definitions in `/home/claude/refs/hermes-agent` directly before finalizing §3.2's cron-job mapping and the fixture's `jobs.json` shape. |
| OpenClaw source-tree layout for the *Hermes-migration-derived* paths | Several OpenClaw-side paths in §4 (`exec-approvals.json`, `credentials/telegram-default-allowFrom.json`, `agents/main/agent/auth-profiles.json`, `~/.openclaw/skills/`, `~/.openclaw/cron/`, `~/.openclaw/extensions/`) were inferred from `openclaw_to_hermes.py`'s own path-construction logic (Hermes's view of OpenClaw), not independently confirmed against the OpenClaw repository directly, except where this document's own direct reads (§2.1, §2.2) already superseded them (state DB location, cron table, channel config, skills config). | Cross-check the still-unconfirmed paths (`exec-approvals.json`, `credentials/telegram-default-allowFrom.json`, `extensions/`) against `/home/claude/refs/openclaw` directly; several (e.g. `agents/main/agent/auth-profiles.json`) are already corroborated by this document's own §2.1 legacy-auth finding, but the exact filename for the command-allowlist store (`exec-approvals.json`) was not independently opened in the OpenClaw checkout this pass. |
| Tombstone on-disk shape | Referenced only via the `/forget` archive-first behavior in the auftrag; no direct file/table read this pass. | Open the tombstone read/write path in `/home/claude/refs/openclaw-plur1bus-memory` before the fixture (§6.1) asserts on tombstone content rather than just copying the directory opaquely. |
| `appendDestructiveOpLog` body | Path located (`lib/sql-safety.js:192`) but body not read; audit-entry shape assumed in §5.8 by analogy with the ACL audit log, not confirmed for this specific log. | Read `lib/sql-safety.js` around line 192 in `/home/claude/refs/openclaw-plur1bus-memory` before finalizing the importer's own audit-entry schema. |

---

## 8. Detect (read-only, pulled forward)

**Status:** built 2026-09-27 (owner pulled it forward from M7). Phase 1 of §5.1 on its own: `plur1bus import <openclaw|hermes> --detect [--source <path>] [--profile <name>] [--map <source-prefix>=<local-prefix>]… [--json]`. It plans nothing and writes nothing — not to the source, not to the harness home.

### 8.1 Where it runs

The Rust CLI spawns Node once on `import.js`, a second entry of `packages/core` shipped beside `core.js` in the core payload (`$PLUR1BUS_IMPORT_JS`, else `import.js` next to `$PLUR1BUS_CORE_JS` / `<home>/runtime/core/core.js`; Node from `$PLUR1BUS_NODE` / `<home>/runtime/node-*` / `PATH`, the same lookup as `core run`). Node is required because detect reads LanceDB (with the engine's own `@lancedb/lancedb`, resolved through the pinned engine package, so the harness reads the source store with the same library version the engine writes it with) and SQLite (`node:sqlite`). It is **not** the core: no engine is constructed, the core lock is not taken, no running core or supervisor is contacted, so detect works with the harness stopped and on a machine where the harness was never set up. The Node side prints one envelope line (`{"ok":true,"schema","value","human"}` or `{"ok":false,"error","message","reason","exit"}`); the Rust side prints `value` as the `--json` document (with `schema` inserted, ADR-016 §8) or the human rendering.

### 8.2 Read-only rules

- SQLite is never opened in place for writing: a database up to 256 MiB is copied (with its `-wal`) into a private temp directory and opened there, so a live source's WAL is honoured and the source's `-shm`/`-wal` are never touched; a larger one is opened `readOnly` with `immutable=1` and the report warns that its WAL was not consulted. The copy is **checked** (HM3, plugin-distribution spec §B.5): size and mtime of the database and its WAL are recorded before and after the copy, and the copy must pass `PRAGMA quick_check`; a change or failure is retried (waits 50/200/800 ms, four attempts in all), after which the database is *busy* — detect then warns `source-busy` and reads it `immutable=1` (without its WAL); a caller that needs an exact copy gets `E_SOURCE_BUSY reason=source-busy` (exit 3). The copy stays in the OS temp directory so that detect keeps writing nothing to the harness home; the staging directory is a parameter for the M7 snapshot producer.
- LanceDB is opened only for `schema()`, `countRows()` and, when the table has an `embeddingFingerprint` column, a projection of that one column. No content column (`text`, …) is ever selected; the embedding cache's `debug_text` column is never selected.
- Secrets are never read: `auth.json`, `auth-profiles.json`, `credentials/`, `agents/*/agent/openclaw-agent.sqlite` are reported by presence only; `.env` files are parsed for **key names** only (the value part of each line is discarded unread-into-output); config values at secret-shaped keys (`apiKey`, `token`, `secret`, `password`, `authorization`, `headers`, …) are reported by JSON path and whether they are an `${ENV}` reference.
- No network, no provider call, no model load.
- Tests assert the source fixture is byte-identical (paths, contents, mtimes) before and after, including while a writer keeps the fixture's SQLite database open in WAL mode.

### 8.3 Source root and version

| | OpenClaw | Hermes |
|---|---|---|
| Root order | `--source`, `$OPENCLAW_STATE_DIR`, `$OPENCLAW_PROFILE` (`<home>/.openclaw-<profile>`), `<home>/.openclaw`, else the legacy `<home>/.clawdbot` when only it exists (`resolvedFrom: default-legacy`); `<home>` = `$OPENCLAW_HOME` (a leading `~` against the OS home) → `$HOME` → `$USERPROFILE` → `os.homedir()` on **every** OS, so `HOME` set on Windows (Git Bash) wins as it does for OpenClaw (`src/config/state-dir.ts`, `src/cli/profile-utils.ts`, `packages/normalization-core/src/home-dir.ts` @ `b9421f4`) | `--source`, `$HERMES_HOME` (expanded like Hermes does: `$VAR`/`${VAR}`, on Windows also `%VAR%`, then `~` — `USERPROFILE` on Windows, `HOME` elsewhere), else `%LOCALAPPDATA%\hermes` on Windows (fallback `%USERPROFILE%\AppData\Local\hermes`) and `~/.hermes` elsewhere (`hermes_constants.py` @ `743ee72`). A `$HERMES_HOME` of `<root>/profiles/<name>` (profile mode) resolves to `<root>` narrowed to that profile; a different `--profile` is `E_INVALID_PARAMS reason=profile-conflict`. `--profile <name>` narrows to `<root>/profiles/<name>` (§3.1, §3.3) |
| Config | `$OPENCLAW_CONFIG_PATH` (ignored with `--source`), else `<root>/openclaw.json`, else the legacy `<root>/clawdbot.json` when only it exists (JSON5; a symlinked file is followed; `$include` is not followed and is reported) | `config.yaml` (read by known key; unsupported YAML constructs make those keys `unknown`, never a guess) |
| "Is an installation" | `openclaw.json` or `state/openclaw.sqlite` present — else `E_SOURCE_NOT_FOUND reason=not-an-openclaw-state-dir` | one of the root markers `config.yaml`, `.env`, `state.db` — else `E_SOURCE_NOT_FOUND reason=not-a-hermes-home` |
| Version | release `meta.lastTouchedVersion` (config) and state schema `schema_meta.schema_version` (`meta_key='primary'`, `state/openclaw.sqlite`; 17 at `b9421f4`) — neither readable → `E_SOURCE_UNSUPPORTED reason=version-undeterminable` | `_config_version` (integer; missing or non-integer → `E_SOURCE_UNSUPPORTED reason=config-version-unreadable`; above 45 → warning `newer-than-tested`), sessions `schema_version.version` (30 tested; informational) |
| Agents | `agents.entries` / `agents.list` / the implicit `main`, plus `agents/<id>/` directories; workspace per `agents.<id>.workspace`, `agents.defaults.workspace/<id>`, else `<root>/workspace-<id>` (`main`: `<root>/workspace`) | `default` (the root) plus each `profiles/<name>` |

### 8.4 What is detected

**PLUR1BUS (OpenClaw).** Plugin entry `plugins.entries["memory-lancedb-namespaced"]` (configured, `enabled`), plugin version from `<root>/extensions/*/package.json` or `<root>/npm/projects/*/node_modules/@cyb3rb1ade/plur1bus-memory/package.json` (else `plugins.installs`). Store root `baseDbPath` (config, else `<root>/memory/lancedb-namespaced`) with the engine's three layouts: `legacy-flat`, `named` (`namespaces`), `generation` (`reembedding.activeGeneration`, `generations/<g>/generation.json`). Stores: one per agent partition `<activeRoot>/<agentId>/memories.lance`, one per shared pool `.plur1bus-shared/{workspaces,users}/<key>/`. Embedding cache `<baseDbPath>/embedding-cache-v2/<scope>.db`, grouped by `(provider, model, dimensions)` with counts. Re-embedding state `control/reembedding-state.json` (full fingerprints per migration). Hermes: `memory.provider` is recorded; there is no Hermes PLUR1BUS adapter yet (M8), so stores and reranker are `not-applicable`.

**Embedding identity per store**, field by field, each `{ value, source }`:

| Field | Sources, in order | Notes |
|---|---|---|
| `provider` (incl. aggregator pin via `endpoint`) | `store-metadata` (fingerprint) · `config` (`embedding.provider`) · `cache` | |
| `model` | `store-metadata` · `config` (`embedding.model` / `embedding.local.model`) · `cache` | |
| `revision` | `store-metadata` · `config` (`embedding.local.revision`) · `model-cache` (exactly one revision directory for the model under `local.cacheDir`, default `<root>/models/plur1bus`) | remote providers: `not-applicable` |
| `artefactHash` | `store-metadata` (SHA-256 over the fingerprint's sorted `{path, sha256}` artefacts) · `derived` (the catalog digest, when model + revision + quantization are confirmed and match the pinned catalog) | |
| `quantization` | `store-metadata` (`dtype`; absent = `fp32`) · `model-cache` (`onnx/model_quantized.onnx` → `q8`, `onnx/model.onnx` → `fp32`) | |
| `dimension` | **`vector-schema`** (the Lance `FixedSizeList` size of the `vector` column) — config, cache and manifest values are corroboration; a disagreement is a `mismatch` with reason `dimension-conflict` | |
| `prefixSchema` | `store-metadata` · `config` (`local.queryPrefix/passagePrefix`) · `derived` (catalog default for the model) | remote: `not-applicable` |
| `normalization` | `store-metadata` (`pooling`, `normalize`) · `derived` (local-transformers always mean-pools and normalizes) | |
| `tokenCap` | `config` (`local.maxTokens`) · `derived` (512, the engine default) | remote: `not-applicable` |
| `endpoint` | `store-metadata` · `config` (`baseUrl`) | local: `not-applicable` |

A field without a confirming source is `unknown`. `derived` counts as confirmed only when every input it is derived from is confirmed. **Any unknown field makes the identity undetermined, and undetermined counts as a mismatch** (§2.3.1): the planned action is `re-embedding-migration`, with the note that M7's compatibility probe can confirm a match later. Each store also reports `distinctIdentities` — the number of distinct identities evidenced for it by generation manifests, per-row `embeddingFingerprint` values and embedding-cache groups — and more than one is a `mismatch` with reason `multiple-identities`.

**Comparison with the harness target.** The target is what `packages/core/src/engine-config.ts` would give the engine for `<home>/config.json` (or the defaults when there is none): local-transformers, `engine.embedding.local.model` (default `intfloat/multilingual-e5-small`), dimension (default 384), and the revision, quantization, prefixes and artefact digest the pinned engine's catalog fixes for that model (sources `harness-config`, `harness-default`, `engine-catalog`). Per field: `match` / `mismatch` / `unknown`; per store a verdict `match` / `mismatch` / `undetermined` and a planned action `take-over` or `re-embedding-migration`.

**Reranker:** §2.3.2.

**Skills.** Every skill folder (a directory holding `SKILL.md`) under the source's roots: OpenClaw `skills.load.extraDirs` (`extra`), `$OPENCLAW_BUNDLED_SKILLS_DIR` (`bundled`, only when set — the bundled set ships inside OpenClaw's package, not the state dir), `<agentDir>/workshop-skills` (`workshop`), `<root>/skills` (`managed`, i.e. installed), `<workspace>/.agents/skills` (`project`), `<workspace>/skills` (`workspace`); Hermes `<profile>/skills/<category>/<name>` (`profile`), `skills.external_dirs` (`external`), `$HERMES_OPTIONAL_SKILLS` (`optional`; an optional skill the user installed already sits under `<profile>/skills`). Per skill: `id` (folder name, lowercased, `^[a-z0-9][a-z0-9._-]{0,63}$`, else problem `invalid-id`), `name` and `description` from the frontmatter (description cut at 300 characters), path, tier, agent, bytes, files, `sha256` (§9.2), `hasScripts` (executable bit, a shebang, a script extension, or a `scripts/` directory), skipped entries (symlink escapes, directory symlinks, secret files, `.git`), problems (`too-large`, `invalid-id`, `no-skill-md`; per target volume, HM3: `unportable-name:<rel>` on Windows for a reserved device name `CON`/`PRN`/`AUX`/`NUL`/`COM0–9`/`LPT0–9` with any extension, a trailing dot or space, or `<>:"|?*\` and control characters — also for the skill id itself; `case-collision:<a>|<b>` on Windows and macOS for two paths inside the skill that differ only by case or Unicode normalisation, and for two skill folders of one root that differ only by case — each refuses the skill, nothing is renamed silently), `shadowedBy` when a higher-precedence root has the same id, and whether the id already exists in the harness (`skills/index.json` or `skills/<id>/`) with its hash — giving the planned action for the default `--on-conflict skip`: `import`, `skip-identical`, `conflict-skip`, `refuse`.

### 8.5 Output

`--json` document `import.detect/1` (top-level keys, stable): `sourceType`, `source {root, resolvedFrom, configPath, profile}`, `version {release, stateSchema, configVersion, sessionsSchema, supported, warnings}`, `target {home, configSource, embedding {fields}, reranker}`, `agents[] {agentId, workspace, workspaceSource, agentDir, foundIn[]}`, `plur1bus {installed, plugin, storeRoot, embeddingCache, reembedding, stores[]}` (each store `{storeId, kind, agentId, namespace, path, rows, identity {fields, distinctIdentities, evidence[], comparison {verdict, fields}, plannedAction, reasons[]}}`), `rerankers[]`, `skills[]`, `secrets {files[], envKeys[], configKeys[]}`, `other {soul, memoryFiles, cron, sessionsDb}` (presence only — M7 entities), `portability` (§8.6), `warnings[]`, `counts`. The human rendering is the same data as short sections. Neither ever contains memory text, skill bodies or secret values.

### 8.6 Cross-platform sources and path mapping

Added 2026-09-28 (HM3; design: `docs/superpowers/specs/2026-09-28-plugin-distribution-and-migration-design.md` §B.1–B.6).

**Where a source is read from.** The root (§8.3) is classified as an *origin* with a *flavour* (the path syntax its configs are written in): `native` (host flavour); `wsl:<distro>` when `--source` is `\\wsl$\<distro>\…`, `\\wsl.localhost\<distro>\…`, or `wsl:<distro>:<path>` (POSIX flavour; the source-side root is the POSIX path inside the distro, the source-side home is `/home/<u>` or `/root` when the root sits there); `windows-from-wsl` when the root is `/mnt/<drive>/…` read inside WSL (`WSL_DISTRO_NAME`/`WSL_INTEROP` set; Windows flavour, home `<drive>:\Users\<u>`); `network` for a UNC share on Windows.

**WSL discovery and probing (G5, C12).** Sources hosted inside WSL can be targeted via `--source wsl:<distro>:<path>` or UNC paths. On Windows, `plur1bus import <openclaw|hermes> --detect` without `--source` enumerates installed WSL distros using `wsl.exe -l -v` (UTF-16LE output). Listing never boots a distro. A stopped distro is probed only with explicit consent via `--probe-wsl` (decision C12); without consent, it is reported as `stopped (not probed)`.

**Snapshot producer and live copy (G6, C7, C10, D2).** Implemented in `packages/core/src/import/snapshot.ts` as the foundational producer building block for D2 (container migration and snapshot staging):
- **Native copier:** bounded copies with before/after stamps. LanceDB stores are copied by manifest; handles both standard and inverted LanceDB V2 manifests (`u64::MAX - version`) with up to 3 retries.
- **WSL tar stream:** streams `tar -h -C <root> -cf - -- <subpaths>` via `wsl.exe` with arguments strictly separated (`--`) and sanitized against command injection. Producer dereferences valid links (`-h`) per §B.6. The streaming extractor unpacks into staging with strict security and integrity guards: all symlinks and hardlinks are strictly rejected (`symlink-forbidden`, `hardlink-forbidden`), 8-byte header checksums are verified, standard two 512-byte zero block EOF marker is required, devices/FIFOs and unsupported typeflags are forbidden, live chunk streaming enforces byte and file count caps, and staging is cleanly removed on corrupt/truncated streams.
- **Running sources (decision C7):** by default, running sources with active daemon/gateway PID files or modifying databases must be stopped (`E_SOURCE_BUSY`, `source-running`). `--allow-live-copy` opts into live copying with SQLite retries/`quick_check` and manifest consistency. SQLite statuses are keyed by relative path to prevent collision across same-named databases in different subdirectories.
- **`snapshot.json` metadata and trust anchor:** records source, origin, flavour, timestamp, file inventory with sha256/sizes, SQLite statuses (`copy`/`immutable`/`source-busy`), and `.env` key names only (no secrets). To prevent path hijack, `snapshot.json` is only trusted under `<home>/import/<run>/snapshot/`, and mount targets outside the snapshot are stripped. `detect` and skills scan run identically against a snapshot.


**Paths inside the source's config** (`agents.*.workspace`, `agents.*.agentDir`, `agents.defaults.workspace`, the plugin's `baseDbPath` and `embedding.local.cacheDir`, `skills.load.extraDirs`, Hermes `skills.external_dirs`) go through one mapper instead of the host's `path` module:

1. Parsed with the **source's** flavour. A drive-letter or `\\server\share` path is Windows syntax, a leading `/` POSIX syntax, whatever the host: a POSIX path in a config read on Windows is never read as `C:\home\…`, a Windows path read on Linux is never resolved under the root. `\x` and `C:x` are `drive-relative` and unmapped.
2. `~` expands against the source-side home; `${OPENCLAW_HOME}` against the source-side root; Hermes also expands `$VAR`/`${VAR}` (and `%VAR%` for a Windows source) from the environment — only for a native source, whose environment is the host's; any other variable is unmapped (`env-var`). Relative paths resolve against the root (Hermes: against the profile directory).
3. Mapped, in order: a `--map <source-prefix>=<local-prefix>` rule (repeatable, longest prefix first, whole segments, case-insensitive for Windows syntax); a path under the source-side root → the same relative path under the root as read; a path through a **same-named root in a home directory** (`/home/<u>/.openclaw/…`, `C:\Users\<u>\.openclaw\…`, `…\AppData\Local\hermes\…`) that is not the root being read → **rebased** onto it (the state dir was copied or moved; reported in `portability.movedFrom` with a warning); a path under the source-side home → under that home as read (unmapped `outside-source-root` when the host cannot reach it); the origin's mounts (WSL: `/mnt/<x>/…` → `<X>:\…`, anything else → `\\wsl.localhost\<distro>\…`; from WSL: `<X>:\…` → `/mnt/<x>/…`); a native source's own-syntax path as written. Anything else is **unmapped** with a reason (`foreign-path`, `drive-relative`, `env-var`, `home-unknown`, `outside-source-root`) and the config key, never guessed; a store root that cannot be mapped falls back to the default path with a warning.
4. Host environment variables that describe the host's installation (`$OPENCLAW_BUNDLED_SKILLS_DIR`, `$HERMES_OPTIONAL_SKILLS`) are read for a native source only. The personal skills root (`~/.agents/skills`) is the source-side user's home (over WSL, the distro user's).

**Tests** (`packages/core/test/import/layouts.ts`): a Linux, a macOS and a Windows layout (non-ASCII user name, the OS's own roots — `%USERPROFILE%\.openclaw`, `%LOCALAPPDATA%\hermes` — config paths in that OS's syntax, CRLF + BOM files on Windows, a directory link (a junction on Windows) and a file link where the process may create one, a skill nested past 300 characters, a PLUR1BUS store in two embedding identities) are generated per run on every CI OS: the layout of the host's own OS is found through that OS's environment, the others are read as copies; the WSL directions run through the mapper everywhere. Symlink cases probe the capability instead of skipping on Windows.

The detect document gains `portability {origin, flavour, sourceRoot, sourceHome, movedFrom[], mapped[] {key, value, path, how}, unmapped[] {key, value, reason}, problems[] {kind, subject, names[]}}` (`problems`: Hermes profile names that collide by case on a Windows/macOS target, or that Windows cannot hold — M7 turns profiles into agent ids; `how`: `root`, `home`, `rebased`, `mount`, `map`; identity mappings are not listed); the human rendering has a *Portability* section when anything was mapped or unmapped.

## 9. Skills import (pulled forward)

**Status:** built 2026-09-27. `plur1bus import <openclaw|hermes> --skills [--apply] [--enable] [--on-conflict skip|rename|replace] [--max-skill-bytes <n>] [--source <path>] [--profile <name>] [--map <source-prefix>=<local-prefix>]…` and `plur1bus import <openclaw|hermes> --rollback <report.json> [--apply]` (everything else comes from the report; `--source`/`--profile` are refused with it). Phases 2–7 of §5.1 for the one entity kind "skill"; the source is read exactly as in §8.2.

### 9.1 Harness skill store (minimal; for the extensions-ecosystem spec to adopt)

No skill store existed in the harness before this (the layout reserved `<home>/skills`, nothing used it). The minimal contract, kept small on purpose so the parallel extensions-ecosystem design (enable/disable/install/uninstall, the plur1bus.app catalogue) can adopt or extend it:

- `<home>/skills/<id>/SKILL.md` plus the rest of the skill folder, one directory per skill id.
- `<home>/skills/index.json`: `{"version": 1, "skills": [{"id", "source", "sourcePath", "sha256", "enabled", "importedAt"}]}`, sorted by `id`. `source` is `"openclaw"` or `"hermes"` for imported skills (the ecosystem spec may add `"bundled"`, `"catalog"`, `"local"`); `sourcePath` is the absolute source folder at import time; `sha256` is §9.2; `importedAt` ISO-8601 UTC. Writers keep unknown top-level and per-entry fields they do not own; the file is replaced atomically (temp + rename).
- Reserved names inside `skills/`: `index.json`, `.staging/`. Import run records live outside it, in `<home>/imports/<runId>/` (`report.json`, `report.txt`, `snapshot/`, `replaced/`, `rolled-back/`), and the importer's lock is `<home>/imports/.lock` (outside `skills/`, so a rollback that swaps the whole directory never moves its own lock).
- **Imported skills land disabled** (`enabled: false`) unless `--enable` — skills can carry scripts; **owner decision to confirm** (D-level entry proposed with this change). `--enable` applies only to skills imported in that run; an already-present skill keeps its flag.

### 9.2 Folder hash `plur1bus-skill-sha256/v1`

Over the files that would be copied (after §9.3's exclusions), sorted by POSIX relative path: `"sha256:" + hex(SHA-256(concat(relpath + "\0" + hex(SHA-256(file bytes)) + "\n")))`. The same algorithm is proposed for D57's pinned bundled skills, so a vendored skill and an imported one are compared with one number.

**Text hash `plur1bus-skill-textsha256/v1`** (added 2026-09-28, HM3): the same construction over each file's *text-normalised* SHA-256 — a file without NUL bytes that decodes as UTF-8 is text; its leading UTF-8 BOM is dropped and CRLF becomes LF (a lone CR stays); any other file uses its byte hash. It is used **only for matching** (skip vs adopt vs conflict), so a skill checked out with `core.autocrlf` on Windows matches its LF twin: against the harness copy it is `skip-identical` with reason `line-endings-differ`, an unindexed twin folder is adopted and the index records the hash of the bytes on disk. `sha256` (v1) is unchanged and stays the copy check and the index value, so every existing `index.json` stays valid; the detect document carries both (`sha256`, `textSha256`).

### 9.3 Copy rules

Copy, never move. A symlinked skill folder is followed to its real directory; inside it, a file symlink that resolves inside the folder is copied as a regular file, one that resolves outside is **skipped** and listed (`symlinkEscapes`), a directory symlink is skipped (no loops). Never copied: `.env`, `.env.*`, `auth.json`, `credentials.json`, `*.pem`, `*.key`, `id_rsa*`, `.git/`, `.DS_Store`. A folder above 8 MiB or 2000 files (`--max-skill-bytes`) is refused `too-large`. Every destination path is resolved inside the staging directory (path traversal is refused).

### 9.4 Apply, idempotency, resumability

Dry-run is the default and writes nothing. `--apply`: take `<home>/imports/.lock` (a live holder → `E_LOCKED`, exit 3; a dead holder's lock is taken over), clear `skills/.staging/`, snapshot `skills/` into `<home>/imports/<runId>/snapshot/`, write `report.json` with status `running` and rewrite it after every skill and at the end (`completed`). Per skill, in root precedence order: copy into `.staging/`, re-hash, rename into `skills/<id>`, then update `index.json`. Same id and same hash → `skip-identical` (zero writes); a folder already on disk with the same hash but no index entry (an interrupted run) is adopted. Re-running after any interruption converges. On Windows every rename, copy and removal on the harness side (staging, `skills/`, `index.json`, reports, snapshot, rollback) retries `EPERM`/`EBUSY`/`EACCES` — a file held for a moment by Defender, the Search indexer or an editor — with growing waits for up to 10 s before it fails (HM3); on POSIX those codes fail at once.

### 9.5 Conflicts

`--on-conflict skip` (default) keeps the harness's skill and reports `conflict-skip`; `rename` imports as `<id>-<source>` (then `-2`, `-3`, …; the frontmatter `name` is unchanged); `replace` moves the existing folder to `<home>/imports/<runId>/replaced/<id>/` first, then imports. A conflict is: the id exists (index or folder) with a different hash. Two source skills with the same id meet the same rule in precedence order.

### 9.6 Report and rollback

`import.skills/1`: `runId`, `sourceType`, `source {root}`, `version`, `mode`, `options`, `startedAt`, `finishedAt`, `status`, `harness {home, skillsDir}`, `snapshot`, `reportPath`, `indexSha256Before`, `indexSha256After`, `skills[] {id, targetId, tier, agentId, sourcePath, sha256, bytes, files, hasScripts, action, outcome, reason, enabled, backupPath}`, `counts`, `errors[]` — ids, paths, hashes and counts only, never skill bodies or secrets. `--rollback <report.json>` checks the run id and that the snapshot lies inside `<home>/imports/<runId>/` (else `E_ROLLBACK_INVALID`), refuses with `E_ROLLBACK_STALE` when `skills/index.json` changed since that run (roll the later run back first), and lists the per-id changes; with `--apply` it moves the current `skills/` to `<home>/imports/<runId>/rolled-back/` and restores the snapshot exactly. It never touches the source.

### 9.7 Hermes skills, soul and cron

Hermes skills follow §3.2 (`skills/<category>/<name>/SKILL.md`, frontmatter preserved verbatim, `.curator_state` not imported). `SOUL.md` and `cron/jobs.json` are detected (presence, §8.5 `other`) but imported only by M7 (§3.2, §4.2): soul → the agent's `SOUL.md` (D14), cron → harness scheduler or archive.
