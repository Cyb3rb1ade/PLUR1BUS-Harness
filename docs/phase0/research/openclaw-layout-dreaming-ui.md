# OpenClaw as Import Source, Dreaming Scheduler Reference, and Control-UI Theme Reference

Check date for all sources: 2026-09-22. Repo cloned shallowly (single branch, full history not fetched) to
`/home/claude/refs/openclaw`, HEAD commit `b9421f4fa69f10404d21c5d55d07fdb0e86dff16` (2026-09-21), `package.json`
`"version": "2026.9.5"`. This is *newer* than every version PLUR1BUS declares compatibility with
(2026.8.1/2026.8.2/2026.9.1) — flagged wherever it matters below. Repo is public:
https://github.com/openclaw/openclaw. Docs site: https://docs.openclaw.ai.

---

## (1) Installation layout for import

### Takeaway
OpenClaw keeps all durable state under one state directory, default `~/.openclaw` (override `$OPENCLAW_STATE_DIR`),
with a single JSON5 config file `openclaw.json` at its root, one SQLite file for shared runtime state, per-agent
SQLite for auth/runtime state, a `workspace/` (or `workspace-<agentId>/`) tree per agent holding the Markdown memory
files, and `agents/<agentId>/sessions/` for transcripts. PLUR1BUS's own state (`baseDbPath`, model cache) is
deliberately placed under the same `~/.openclaw` root but in sibling directories (`~/.openclaw/memory`,
`${OPENCLAW_HOME}/models/plur1bus`) rather than inside OpenClaw's own `agents/` or `workspace/` trees — this is a
PLUR1BUS design choice, not something OpenClaw enforces.

### Cited Findings
- Config file: `~/.openclaw/openclaw.json`, JSON5 (comments/trailing commas allowed); "If the file is missing,
  OpenClaw uses safe defaults." — [docs.openclaw.ai/gateway/configuration](https://docs.openclaw.ai/gateway/configuration) (fetched 2026-09-22, doc version unstated) — confirmed verbatim in repo doc source `docs/gateway/configuration.md:10` (commit `b9421f4`).
- Default agent workspace path set via config key `agents.defaults.workspace`, example value
  `"~/.openclaw/workspace"` — `docs/gateway/configuration.md:36-38` (commit `b9421f4`).
- Full state-directory layout table, verbatim from the repo's own developer doc (this is the single clearest,
  most authoritative source found):

  | Path (relative to `~/.openclaw` or `$OPENCLAW_STATE_DIR`) | Holds |
  | --- | --- |
  | `openclaw.json` | Config |
  | `state/openclaw.sqlite` | Shared runtime state database |
  | `agents/<agentId>/agent/openclaw-agent.sqlite` | Per-agent model auth profiles (API keys + OAuth) and runtime state |
  | `credentials/` | Provider/channel credentials outside the auth profile store |
  | `agents/<agentId>/sessions/` | Transcript history and legacy session migration sources |
  | `sessions/` | Legacy single-agent session store (old installs only) |
  | `workspace/` | Default agent workspace (extra agents use `workspace-<agentId>`) |

  — [file:line] `docs/openclaw-agent-runtime.md:47-59` (repo commit `b9421f4fa69f10404d21c5d55d07fdb0e86dff16`, 2026-09-21; doc has no separate version stamp, applies to the 2026.9.5 tree checked out).
  - Note: "Legacy `auth-profiles.json` files are no longer read at runtime; `openclaw doctor --fix` imports them into the SQLite store." — same file, same location. This is a schema-version signal: older (pre-SQLite-auth) installs used a flat `auth-profiles.json`.
- Skills directory can be symlinked per example `~/.agents/skills/manager -> ~/path/to/skills` —
  `docs/gateway/configuration-examples.md:460` (commit `b9421f4`). Exact default skills directory path (e.g.
  whether it's `~/.openclaw/skills` or under the workspace) was **not confirmed** in the slice of docs fetched —
  see Gaps.
- Cron jobs are configured through the Gateway's own cron/dispatcher system, referenced only as
  "Configure cron jobs" doc link, not inline — `docs/gateway/configuration.md:149` (commit `b9421f4`). The
  concrete on-disk cron job store format was not located in the docs slice fetched; the memory-core plugin itself
  manages its own dreaming cron jobs through a `CronServiceLike` API (`list`/`add`/`update`/`remove`,
  `removeStaleJobFamily`) rather than writing a job file directly —
  `extensions/memory-core/src/dreaming-cron.ts:73-90` (repo commit `b9421f4`).
- Memory file formats/locations (from official docs, `docs.openclaw.ai/concepts/memory`, fetched 2026-09-22):
  - `USER.md` (optional): "stable preferences, communication style, relationships, and active-project context
    written as directives", in the agent workspace.
  - `MEMORY.md`: "long-term memory. Durable non-profile facts and decisions" — "compact, curated layer for durable
    non-profile facts, standing decisions, and short summaries."
  - `memory/YYYY-MM-DD.md` (or `memory/YYYY-MM-DD-<slug>.md`): daily notes, "working layer: detailed daily notes,
    observations, session summaries, and raw context."
  - `DREAMS.md` (optional): "Dream Diary and dreaming sweep summaries for human review."
  - Imports from other tools land under `memory/imports/codex/`, `memory/imports/claude-code/`, or
    `memory/imports/hermes/`, kept separate from the bootstrap `MEMORY.md` rather than merged in.
  - Default memory engine: SQLite-backed, "Works out of the box with keyword search, vector similarity, and
    hybrid search."
  - Source: [docs.openclaw.ai/concepts/memory](https://docs.openclaw.ai/concepts/memory) (fetched 2026-09-22).
  - Confirmed in source: `DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"]` (repo accepts either casing/lookup, but
    only ever *writes* `DREAMS.md`) — `extensions/memory-core/src/dreaming-dreams-file.ts:12` (commit `b9421f4`).
- **KNOWLEDGE.md**: not found as an OpenClaw-native file in either the docs pages fetched or the repo grep. It
  appears in PLUR1BUS's own compatibility notes as a PLUR1BUS/plugin-side concept
  (`registerMemoryCorpusSupplement({...})` → "KNOWLEDGE.md Integration" —
  `/home/claude/refs/openclaw-plur1bus-memory/OPENCLAW_SDK_COMPAT_AUDIT.md:41`), i.e. PLUR1BUS supplies it as a
  corpus supplement rather than OpenClaw shipping it natively. Treat "KNOWLEDGE.md" as PLUR1BUS-side, not
  OpenClaw-side, pending contradiction.
- Cross-check against PLUR1BUS docs: PLUR1BUS's default `baseDbPath` is `~/.openclaw/memory` (i.e. a sibling of
  `agents/` and `workspace/`, still inside the OpenClaw state root), and PLUR1BUS's local-model cache directories
  are `${OPENCLAW_HOME}/models/plur1bus` —
  `/home/claude/refs/openclaw-plur1bus-memory/docs/compatibility-openclaw-2026.8.1-beta.3.md` cross-referenced
  against `/home/claude/refs/openclaw-plur1bus-memory/docs/configuration.md:57,112,122,143,149,169,209` (both
  files, PLUR1BUS repo, read 2026-09-22; PLUR1BUS version these apply to: 7.5.0 targeting
  `openclaw@2026.8.1`–`2026.9.1`).
- Session storage schema-version signal: OpenClaw migrated inbound channel queues and iMessage monitor state "to
  SQLite-backed tracking" and persists "the plugin install index in SQLite", per PLUR1BUS's own v6 breaking-change
  audit of OpenClaw v2026.5.28-beta.4 → v2026.6.1-beta.2 —
  `/home/claude/refs/openclaw-plur1bus-memory/OPENCLAW_SDK_COMPAT_AUDIT.md:73,85-86` (PLUR1BUS repo, dated
  2026-06-02).

### Inferences
- Because OpenClaw keeps everything under one state root and PLUR1BUS deliberately nests its own DB and model
  cache inside that same root (`~/.openclaw/memory`, `~/.openclaw/models/plur1bus` via `${OPENCLAW_HOME}`), an
  "import" tool for OpenClaw data should walk `~/.openclaw/agents/<agentId>/{sessions,agent/openclaw-agent.sqlite}`
  and `~/.openclaw/workspace*/{MEMORY.md,USER.md,DREAMS.md,memory/*.md}` as the two OpenClaw-native trees to read,
  while treating `~/.openclaw/memory` (PLUR1BUS's LanceDB) and `~/.openclaw/models/plur1bus` as belonging to the
  plugin, not the host, when deciding what counts as "OpenClaw data" versus "PLUR1BUS data" during import.
- The existence of `memory/imports/<tool>/` subdirectories in OpenClaw's own memory doc suggests OpenClaw's
  authors already anticipated cross-tool import as a first-class operation and expect imported material to be
  namespaced by source tool rather than merged into `MEMORY.md` directly — ADR-009/import.md should probably
  follow the same convention for anything PLUR1BUS imports from a raw OpenClaw install.

### Gaps
- Exact default skills directory (e.g. `~/.openclaw/skills` vs. per-agent) not confirmed — only a symlink example
  (`~/.agents/skills/manager`) was found, which uses a *different* root (`~/.agents`, not `~/.openclaw`) than the
  main state directory documented elsewhere; this may be a distinct, skill-specific override, not the default
  path. Mark unverified.
- Cron job on-disk store format/path (e.g. whether it's a table in `state/openclaw.sqlite` or a separate file) not
  directly confirmed by file read; only the plugin-facing `CronServiceLike` API surface was found in memory-core.
  Given the "SQLite-backed" pattern used everywhere else in the same version range, a cron table inside
  `state/openclaw.sqlite` is plausible but unverified — do not state as fact in ADR text.
- Persona file format/location, channel config file paths, and channel allowlist file format were not located in
  the docs pages or repo paths checked in the time available. Only a general "Set models, tools, sandboxing, or
  automation (cron, hooks)" mention exists — `docs/gateway/configuration.md:17`. Needs a follow-up read of
  `docs/gateway/configuration-examples.md` in full and/or `docs/gateway/pairing.md`.
- Provider/model config format beyond the JSON5 `openclaw.json` root key structure not enumerated in detail here;
  only the workspace/agents keys were confirmed.
- No schema-version numbers (e.g. "config schema v3") were found anywhere in the docs or code paths checked;
  OpenClaw appears to version by release date/semver (`2026.9.5`) rather than by an internal config schema
  version field. Mark as "no separate schema-version scheme found," not confirmed absent.

---

## (2) Dreaming / sleep plan

### Takeaway
OpenClaw's dreaming system is implemented in the bundled `memory-core` plugin (`extensions/memory-core/`, host
helpers in `src/memory-host-sdk/dreaming.ts`), matches the three-phase Schlafplan description closely (Light →
REM → Deep, mapped internally to `light`/`rem`/`deep`), is driven by one managed cron job per phase family with a
`0 3 * * *` default expression and a plugin-config `dreaming.timezone`, and is independently enable/disable-able
per phase. The Deep phase is the only phase that writes `MEMORY.md`; all three can write to `DREAMS.md`/daily
managed blocks. There is a real, documented history of dreaming silently failing to run or to write, tracked as
open/closed GitHub issues.

### Config schema (from source, `src/memory-host-sdk/dreaming.ts`, repo commit `b9421f4`, version 2026.9.5)
Top-level `dreaming` config shape (all defaults as literally defined in source):

```
dreaming: {
  enabled: true,                    // DEFAULT_MEMORY_DREAMING_ENABLED
  frequency: "0 3 * * *",           // DEFAULT_MEMORY_DREAMING_FREQUENCY
  timezone: undefined,              // DEFAULT_MEMORY_DREAMING_TIMEZONE (host/OS local time if unset)
  verboseLogging: false,
  storage: { mode: "separate", separateReports: false },
  execution: { defaults: { speed: "balanced", thinking: "medium", budget: "medium" } },
  phases: {
    light: {
      enabled: <inherits top-level enabled unless overridden>,
      cron: <can override frequency per-phase>,
      lookbackDays: 2,               // DEFAULT_MEMORY_LIGHT_DREAMING_LOOKBACK_DAYS
      limit: 100,                    // DEFAULT_MEMORY_LIGHT_DREAMING_LIMIT
      dedupeSimilarity: 0.9,         // DEFAULT_MEMORY_LIGHT_DREAMING_DEDUPE_SIMILARITY
      sources: ["daily","sessions","recall"],
    },
    deep: {
      limit: 10,                     // DEFAULT_MEMORY_DEEP_DREAMING_LIMIT
      minScore: 0.75,                // DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE
      minRecallCount: 3,             // DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT
      minUniqueQueries: 3,           // DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES
      recencyHalfLifeDays: 14,       // DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS
      maxAgeDays: 30,                // DEFAULT_MEMORY_DEEP_DREAMING_MAX_AGE_DAYS
      maxPromotedSnippetTokens: 160, // DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS
      maxPriorEntryLossFraction: 0.25,
      sources: ["daily","memory","sessions","logs","recall"],
      recovery: {
        enabled: true,
        triggerBelowHealth: 0.35,
        lookbackDays: 30,
        maxRecoveredCandidates: 20,
        minRecoveryConfidence: 0.9,
        autoWriteMinConfidence: 0.97,
      },
    },
    rem: {
      lookbackDays: 7,               // DEFAULT_MEMORY_REM_DREAMING_LOOKBACK_DAYS
      limit: 10,                     // DEFAULT_MEMORY_REM_DREAMING_LIMIT
      minPatternStrength: 0.75,      // DEFAULT_MEMORY_REM_DREAMING_MIN_PATTERN_STRENGTH
      sources: ["memory","daily","deep"],
    },
  },
}
```
Source: [file:line] `src/memory-host-sdk/dreaming.ts:21-56,207-241,266-283` (repo commit `b9421f4fa69f10404d21c5d55d07fdb0e86dff16`, version `2026.9.5`, checked 2026-09-22). Note the "Deterministic calibration" comment at line 42-43 documenting the empirical basis for `minScore=0.75`: "scores 3-day/3-query durable facts at 0.750-0.756, versus repeated filler at 0.489-0.549 and high-relevance one-offs at 0.529-0.606."

The plugin id under which dreaming is configured is `memory-core` — `DEFAULT_MEMORY_DREAMING_PLUGIN_ID = "memory-core"`,
same file, line 30. This matches PLUR1BUS's own docs, which key the disable-flag off exactly this plugin id:
`plugins.entries.memory-core` for OpenClaw's dreaming vs. `plugins.entries.memory-lancedb-namespaced.config.dreaming.enabled: false`
for PLUR1BUS's own dreaming — [file:line]
`/home/claude/refs/openclaw-plur1bus-memory/docs/compatibility-openclaw.md:179` (PLUR1BUS repo, read 2026-09-22).

### Managed cron job mechanics
- One declared managed cron job family per dreaming sweep, reconciled (added/updated/removed) idempotently by a
  `CronServiceLike` interface (`list`, `add`, `update`, `remove`, `removeStaleJobFamily`) rather than the plugin
  writing a job file directly — `extensions/memory-core/src/dreaming-cron.ts:73-116` (commit `b9421f4`).
- Job shape: `{ declarationKey: "memory-core:memory-dreaming-promotion", name: "Memory Dreaming Promotion", schedule: { kind: "cron", expr: config.cron, tz?: config.timezone }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: MEMORY_DREAMING_SYSTEM_EVENT_TEXT, lightContext: true }, delivery: { mode: "none" } }` —
  same file, lines 96-121. The system-event text is the literal string
  `"__openclaw_memory_core_short_term_promotion_dream__"` — `src/memory-host-sdk/dreaming.ts:28-29`.
- **Legacy names found in source** (still present as constants, meaning older installs may have separate Light-
  and REM-named jobs that get migrated/removed): `LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME = "Memory Light Dreaming"`
  (`[managed-by=memory-core.dreaming.light]`, event text `"__openclaw_memory_core_light_sleep__"`) and
  `LEGACY_MEMORY_REM_DREAMING_CRON_NAME = "Memory REM Dreaming"`
  (`[managed-by=memory-core.dreaming.rem]`, event text `"__openclaw_memory_core_rem_sleep__"`) —
  `src/memory-host-sdk/dreaming.ts:31-36`. This confirms the three phases used to run on **separate** cron jobs and
  were consolidated into one managed job that triggers all three phases in sequence per sweep (see
  `dreaming-cron.ts` import list referencing both legacy and current constants,
  `extensions/memory-core/src/dreaming-cron.ts:1-13`).
- The cron reconciliation runs on a periodic interval check as well:
  `RUNTIME_CRON_RECONCILE_INTERVAL_MS = 60_000` (60s) — `extensions/memory-core/src/dreaming.ts:27`.

### Phase-by-phase table

| Phase | Trigger/schedule | Reads | Writes | Uses LLM? | Observable status today | Known failure modes |
| --- | --- | --- | --- | --- | --- | --- |
| **Light** (Leichtschlafphase) | Same managed cron as the whole sweep, default `0 3 * * *`, per-plugin `dreaming.timezone` (host-local if unset); fires as an isolated-session `agentTurn` system event `__openclaw_memory_core_short_term_promotion_dream__` [`src/memory-host-sdk/dreaming.ts:28-29`, `extensions/memory-core/src/dreaming-cron.ts:96-121`] | "recent short-term recall state, daily memory files, and redacted session transcripts" [docs.openclaw.ai/concepts/dreaming, fetched 2026-09-22]; in source: daily files + session transcripts + short-term recall entries, bounded by `lookbackDays=2`, `limit=100`, deduped at `dedupeSimilarity=0.9` [`src/memory-host-sdk/dreaming.ts:207-215,266-268`]; reads via `readShortTermRecallEntries`, `filterFreshLightDreamingEntries`, `listSessionTranscriptCorpusEntriesForAgent` [`extensions/memory-core/src/dreaming-phases.ts:1-80`] | Stages candidate lines/dedupes signals into short-term store; "Writes a managed `## Light Sleep` block when storage includes inline output" [docs.openclaw.ai/concepts/dreaming]; managed block markers `<!-- openclaw:dreaming:light:start/end -->` written into the daily memory file [`extensions/memory-core/src/dreaming-phases.ts:129-137`]; does **not** touch MEMORY.md | Yes — `execution` block controls `speed/thinking/budget/model` per phase, default `balanced/medium/medium`; narrative generation calls `runDreamNarrative` [`extensions/memory-core/src/dreaming-narrative.ts`, `dreaming-phases.ts` imports] | `/dreaming status` CLI/dashboard command [docs.openclaw.ai/concepts/dreaming]; dashboard tab shows "phase-level status and managed-sweep presence" (per docs summary) — exact UI surfacing not independently confirmed in source in the time available | GitHub #62920 "managed dreaming cron not created after plugin startup or config change"; GitHub #62296 "dreaming cron system-event does not trigger before_agent_reply hook (deliveryStatus: not-requested)"; GitHub #62857 "'Dreaming' feature silently fails to initialize in v2026.4.5" — all https://github.com/openclaw/openclaw/issues (titles from search results, fetched 2026-09-22; not individually opened/read, so status/resolution unconfirmed) |
| **REM** (REM-Phase) | Same managed sweep/cron as Light; runs after Light within the same triggered turn [`extensions/memory-core/src/dreaming.ts` orchestration via `runDreamingSweepPhases`, `dreaming-phases.ts`] | "Builds theme and reflection summaries from recent short-term traces" [docs.openclaw.ai/concepts/dreaming]; source: `lookbackDays=7`, `limit=10`, `minPatternStrength=0.75`, sources `["memory","daily","deep"]` [`src/memory-host-sdk/dreaming.ts:232-241,283`]; reads via `recordRemConsideredPhaseSignals` / `recordDreamingPhaseSignals` [`extensions/memory-core/src/dreaming-phases.ts` imports, `short-term-promotion.ts`] | "Writes a managed `## REM Sleep` block when storage includes inline output" [docs.openclaw.ai/concepts/dreaming]; managed markers `<!-- openclaw:dreaming:rem:start/end -->` [`extensions/memory-core/src/dreaming-phases.ts:131-137`]; records reinforcement signals used by Deep's ranking; does **not** touch MEMORY.md | Yes (same `execution` config surface as Light/Deep) | Same `/dreaming status` surface as Light; no separate REM-only status command found | Same cron-not-created / silent-init-failure issues apply since REM shares Light's trigger path; also GitHub #143206 "Dreaming run with failed and pending narratives is recorded as OK without retry" — a REM/Deep-adjacent narrative-failure masking bug — https://github.com/openclaw/openclaw/issues/143206 (fetched 2026-09-22, not independently opened) |
| **Deep** (Tiefschlafphase) | Same managed sweep/cron; runs last in the sequence | "Ranks candidates with weighted scoring and threshold gates" using `minScore=0.75`, `minRecallCount=3`, `minUniqueQueries=3`, `recencyHalfLifeDays=14`, `maxAgeDays=30` [docs.openclaw.ai/concepts/dreaming + `src/memory-host-sdk/dreaming.ts:44-49`]; "Rehydrates snippets from live daily files before writing, so stale/deleted snippets are skipped" [docs.openclaw.ai/concepts/dreaming]; sources `["daily","memory","sessions","logs","recall"]` [`src/memory-host-sdk/dreaming.ts:227`]; has its own recovery sub-config (`recovery.enabled=true`, `triggerBelowHealth=0.35`, `lookbackDays=30`, `maxRecoveredCandidates=20`, `minRecoveryConfidence=0.9`, `autoWriteMinConfidence=0.97`) for reviving degraded/low-health memory state [`src/memory-host-sdk/dreaming.ts:210-215`] | "Performs consolidation or falls back to append-only promotion"; "Writes a `## Deep Sleep` summary into `DREAMS.md`" [docs.openclaw.ai/concepts/dreaming]; is the **only** phase that promotes into `MEMORY.md` [PLUR1BUS's own overlap table independently corroborates: "Memory-core dreaming | Consolidation, REM, promotion, diary" — `/home/claude/refs/openclaw-plur1bus-memory/docs/compatibility-openclaw.md:179`]; caps promoted-snippet size at `maxPromotedSnippetTokens=160` and limits prior-entry loss to `maxPriorEntryLossFraction=0.25` per sweep [`src/memory-host-sdk/dreaming.ts:47-48`]; writes `DREAMS.md` via `writeDeepDreamingReport` in `dreaming-markdown.ts`, which enforces "Refusing to write symlinked DREAMS.md" / "Refusing to write non-file DREAMS.md" guards [`extensions/memory-core/src/dreaming-dreams-file.ts:76,79`] | Yes | `/dreaming status`; separate phase reports optionally stored under `memory/dreaming/<phase>/YYYY-MM-DD.md` when `storage.mode` includes "separate" reporting (default `mode: "separate", separateReports: false`, meaning separate-report files are off by default even though mode defaults to "separate" for the block itself — this nuance is worth re-checking against the live `/dreaming status` output, not just the default config, before ADR-009 relies on it) | GitHub #65412 "[Bug] Dreaming narrative never writes to DREAMS.md — snippets/promotions always empty"; GitHub #67922 "[Bug] Dream Diary outputs to stdout instead of DREAMS.md"; GitHub #154153 "Dream Diary narrative aborts with 'No callable tools remain ... explicit tool allowlist' when tools.alsoAllow is set"; GitHub #151866 "memory-core dreaming sentinel reaches provider with explicit OpenClaw runtime (2026.9.4)" — all https://github.com/openclaw/openclaw/issues (titles only, from web search, fetched 2026-09-22; **none of these issue pages were opened/read directly, so current status — open/closed/fixed-in-version — is unverified**; treat titles as evidence dreaming-write failures are a recurring, named class of bug, not as confirmation any specific one is still open in 2026.9.5) |

### Enable/disable
- Global: `plugins.entries.memory-core.config.dreaming.enabled: false` disables all three phases for OpenClaw's
  own dreaming (`DEFAULT_MEMORY_DREAMING_ENABLED = true`, i.e. dreaming is **on by default** — matches
  "Enabled by default unless explicitly disabled" from docs.openclaw.ai/concepts/dreaming).
- Per-phase: each phase config object (`light`, `deep`, `rem`) carries its own `enabled` field in the type
  definitions (`MemoryLightDreamingConfig`, `MemoryDeepDreamingConfig`, `MemoryRemDreamingConfig` all have
  `enabled: boolean` — `src/memory-host-sdk/dreaming.ts:207-241`), confirming each phase is independently
  toggleable as the Schlafplan description states, though the exact default per-phase `enabled` value (inherit
  top-level vs its own literal default) was not pinned down beyond "inherits unless overridden" — mark as
  probable, not confirmed literal-default.
- PLUR1BUS's own compatibility contract treats OpenClaw's `memory-core` dreaming and PLUR1BUS's own
  dreaming/merging as mutually exclusive by policy: "Set persisted
  `plugins.entries.memory-lancedb-namespaced.config.dreaming.enabled: false` when PLUR1BUS owns dreaming.
  Otherwise OpenClaw intentionally loads `memory-core` as a sidecar." —
  `/home/claude/refs/openclaw-plur1bus-memory/docs/compatibility-openclaw.md:179`.

### Inferences
- The presence of `LEGACY_MEMORY_LIGHT_DREAMING_*` / `LEGACY_MEMORY_REM_DREAMING_*` constants alongside a single
  consolidated `MANAGED_MEMORY_DREAMING_CRON_NAME` strongly implies OpenClaw's dreaming architecture changed at
  some point from three independently-scheduled cron jobs (one per phase) to one cron job that runs all three
  phases in sequence per sweep. ADR-009 should note this as a precedent: consolidating multiple scheduled phases
  into one dispatch reduces the "N cron jobs get out of sync" failure class but concentrates all three phases'
  failure modes onto a single trigger path (if the one system event never fires or never gets acted on, *no*
  phase runs at all) — which is consistent with the issue titles found (#62920, #62296, #62857 all describe the
  *cron/trigger* failing, not an individual phase's logic).
- The recurring pattern across the cited issues — cron not created, system event not consumed, narrative aborting
  on tool-allowlist restrictions, output going to stdout instead of the file — suggests the most fragile links in
  the dreaming pipeline are (a) the cron→system-event→agent-turn handoff and (b) the LLM narrative step's
  interaction with per-agent tool allowlists, rather than the scoring/ranking logic itself. This is useful input
  for ADR-009's own risk register if PLUR1BUS's dreaming design reuses a similar cron-triggers-an-agent-turn
  shape.

### Gaps
- None of the cited GitHub issue pages were opened directly (only titles surfaced via web search) — their
  current open/closed status, root cause, and fix-version are **unverified**. A researcher with more tool budget
  should open each issue via `gh api` or WebFetch and record status/resolution before ADR-009 cites them as
  "known, currently-open problems" rather than "historically reported problems."
- Exact wording and screenshots of the "how dreaming works" in-product guide (mentioned in the task's screenshot
  description) were not independently located beyond the `docs.openclaw.ai/concepts/dreaming` page fetched here;
  if the guide referenced is a different, in-app-only document, it was not found.
- The precise mechanism for how "status/last-run is (not) surfaced" beyond the `/dreaming status` command and a
  vague "dashboard tab" mention was not traced into UI source (e.g. no `ui/src/pages/*dreaming*status*` file was
  opened) — only `ui/src/pages/config/memory-dreaming.ts` (a config-form file, referenced once for the cron
  placeholder default) was touched. A dedicated status-surface confirmation is a gap.
- Short-term store's exact on-disk path/filename was not fully pinned (source confirms it's referred to via
  `storePath` in `ShortTermAuditSummary`/`ShortTermDreamingStats` types, `src/memory-host-sdk/dreaming.ts:130-193`,
  but the literal path string wasn't located in the files read) — likely under the agent workspace or state dir,
  unconfirmed.

---

## (3) Control UI design tokens

### Takeaway
OpenClaw's Control UI theme is a plain CSS custom-property system defined in `ui/src/styles/base.css` (raw token
values, dark-first) with a semantic bridge layer in `ui/src/styles/carapace-control-ui.css` that maps a `--oc-*`
namespace onto the base tokens for its component library ("Carapace"). The bridge file carries an explicit MIT
license header with required attribution text; the whole `openclaw/openclaw` repo is MIT-licensed at the root.
Default theme is dark; light mode applies only when the OS reports `prefers-color-scheme: light` (or the user
explicitly opts in), matching "dark default / light per OS."

### License and attribution (verbatim)
- Root repo license: MIT, `Copyright (c) 2026 OpenClaw Foundation` — `/home/claude/refs/openclaw/LICENSE` (repo
  commit `b9421f4`, read 2026-09-22).
- The Control-UI/Carapace bridge file carries its own attribution comment, verbatim:
  > `/* Adapted from openclaw/carapace at 6c38d2a9b558104957d581033bce5a127632d60e.`
  > ` * MIT License, Copyright (c) 2026 openclaw.`
  > ` * Permission is hereby granted, free of charge, to any person obtaining a copy`
  > ` * of this software and associated documentation files (the "Software"), to deal`
  > ` * in the Software without restriction, including without limitation the rights`
  > ` * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell`
  > ` * copies of the Software, and to permit persons to whom the Software is`
  > ` * furnished to do so, subject to the following conditions:`
  > ` *`
  > ` * The above copyright notice and this permission notice shall be included in`
  > ` * all copies or substantial portions of the Software.`
  > ` * ... [standard MIT no-warranty clause] ...`
  > ` *`
  > ` * Control UI owns theme selection; Carapace owns the semantic component roles.`
  > ` * Keeping this bridge pointed at the resolved Control UI tokens makes every`
  > ` * shipped theme family, mode, and imported custom theme work without a`
  > ` * Carapace-side copy of the product theme catalog. */`

  — `/home/claude/refs/openclaw/ui/src/styles/carapace-control-ui.css:1-23` (repo commit `b9421f4fa69f10404d21c5d55d07fdb0e86dff16`, version 2026.9.5, read 2026-09-22). **This is data, quoted verbatim, and is the exact attribution PLUR1BUS's own Control-UI-tab CSS must carry if it reuses/adapts these tokens for ADR-004.**

### Default (dark) base tokens — verbatim values (`ui/src/styles/base.css:1-`, `:root` block)
| Token | Value | Note |
| --- | --- | --- |
| `--bg` | `#0e1015` | page background |
| `--bg-accent` | `#13151b` | |
| `--bg-elevated` | `#191c24` | |
| `--bg-hover` | `#1f2330` | |
| `--bg-muted` | `#1f2330` | |
| `--card` | `#161920` | card/surface bg |
| `--card-foreground` | `#f0f0f2` | |
| `--card-highlight` | `rgba(255,255,255,0.04)` | |
| `--popover` | `#191c24` | |
| `--popover-foreground` | `#f0f0f2` | |
| `--panel` | `#0e1015` | |
| `--panel-strong` | `#191c24` | |
| `--panel-hover` | `#1f2330` | |
| `--text` | `#bcbcc0` | ~10:1 on `--bg` per inline WCAG audit comment |
| `--text-strong` | `#f4f4f5` | |
| `--muted` | `#8b8b94` | |
| `--muted-strong` | `#898990` | |
| `--border` | `#1e2028` | |
| `--border-strong` | `#2e3040` | |
| `--border-hover` | `#3e4050` | |
| `--input` | `#1e2028` | |
| `--ring` | `#ff5c5c` | focus ring, matches accent |
| `--accent` | `#ff5c5c` | 6.3:1 AA on `--bg` per inline audit comment |
| `--accent-hover` | `#ff7070` | |
| `--accent-subtle` | `rgba(255,92,92,0.1)` | |
| `--accent-foreground` | `#fafafa` | |
| `--accent-glow` | `rgba(255,92,92,0.2)` | |
| `--link` | `color-mix(in srgb, var(--accent-hover) 85%, var(--text))` | derived, not literal per-theme |
| `--selection-bg` | `#005fcc` | |
| `--selection-fg` | `#ffffff` | |
| `--primary` | `#d13c3c` | |
| `--primary-hover` | `#c22e2e` | |
| `--primary-foreground` | `#ffffff` | |
| `--secondary` | `#161920` | |
| `--secondary-foreground` | `#f0f0f2` | |
| `--accent-2` | `#14b8a6` | secondary accent hue |
| `--accent-2-muted` | `rgba(20,184,166,0.7)` | |
| `--accent-2-subtle` | `rgba(20,184,166,0.1)` | |
| `--destructive` (dark override, `:root[data-theme="dark"]`) | `#d32f2f` | |
| `--destructive-hover` | `#bc2a2a` | |

Source: `/home/claude/refs/openclaw/ui/src/styles/base.css:2-165,517-521` (repo commit `b9421f4`, v2026.9.5, read
2026-09-22). File includes an inline WCAG 2.1 AA contrast audit as a comment (quoted): "`--accent #ff5c5c on bg:
6.3:1 AA text ✓`", "`--primary-foreground #ffffff on #d13c3c button: 4.75:1 AA ✓`", etc.

### Light theme tokens — verbatim values (`:root:where([data-theme-mode="light"])` block)
| Token | Value |
| --- | --- |
| `--bg` | `#faf9f7` |
| `--bg-accent` | `#f4f1ec` |
| `--bg-elevated` | `#ffffff` |
| `--bg-hover` | `#efebe4` |
| `--card` | `#ffffff` |
| `--card-foreground` | `#211e1a` |
| `--text` | `#403c35` |
| `--text-strong` | `#211e1a` |
| `--muted` | `#6e6960` |
| `--border` | `#e8e4dc` |
| `--border-strong` | `#d6d0c5` |
| `--input` | `#e8e4dc` |
| `--ring` | `#bd4531` |
| `--accent` | `#bd4531` |
| `--accent-hover` | `#a83c29` |
| `--primary` | `#bd4531` |
| `--primary-foreground` | `#ffffff` |
| `--secondary` | `#f4f1ec` |
| `--accent-2` | `#0d9488` |

Source: same file, `:519-600` (repo commit `b9421f4`). Inline comment: "Warm paper light mode - terracotta accent
on ivory... `--accent #bd4531 contrast ≈ 4.9:1 AA text ✓`."

### Dark-default / light-per-OS mechanism
- `globalThis.matchMedia("(prefers-color-scheme: light)").matches` is the actual runtime check used to decide
  whether to apply the light theme — `ui/src/app/theme.ts:41` and `ui/src/app/bootstrap-theme.ts:177` (repo
  commit `b9421f4`). The check is phrased as "does the OS prefer *light*" (not dark), i.e. dark is the fallback /
  default state when no explicit preference or override is present, confirming "dark default / light per OS."
  No `@media (prefers-color-scheme: dark)` rule was found in `base.css` — the dark block is simply the bare
  `:root` default, with light applied via the `data-theme-mode="light"` attribute selector set by that JS check
  (or an explicit user setting).

### Typography, spacing, radius, motion tokens — verbatim
| Token | Value |
| --- | --- |
| `--font-body` | `"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` |
| `--font-display` | `var(--font-body)` |
| `--font-chat` | `var(--font-body)` |
| `--control-ui-text-xs` | `calc(11px * var(--control-ui-text-scale))` |
| `--control-ui-text-sm` | `calc(12px * var(--control-ui-text-scale))` |
| `--control-ui-text-md` | `calc(14px * var(--control-ui-text-scale))` |
| `--control-ui-text-lg` | `calc(16px * var(--control-ui-text-scale))` |
| `--space-1`…`--space-4` | `4px, 8px, 12px, 16px` |
| `--radius-sm` | `6px` |
| `--radius-md` | `10px` |
| `--radius-lg` | `14px` |
| `--radius-xl` | `20px` |
| `--radius-full` | `9999px` |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--duration-fast` | `100ms` |
| `--duration-normal` | `180ms` |
| `--z-dropdown` | `100` |
| `--z-toast` | `2000` |

Source: `/home/claude/refs/openclaw/ui/src/styles/base.css:230-335` (repo commit `b9421f4`, v2026.9.5).

### `--oc-*` semantic bridge (Carapace component tokens) — key mappings, verbatim
```
--oc-bg-page: var(--bg);              --oc-bg-surface: var(--card);
--oc-accent-primary: var(--accent);   --oc-accent-primary-hover: var(--accent-hover);
--oc-text-primary: var(--text-strong);--oc-text-secondary: var(--text);
--oc-text-muted: var(--muted);        --oc-border-subtle: var(--border);
--oc-border-strong: var(--border-strong);
--oc-radius-surface: var(--radius-lg);--oc-radius-control: var(--radius-md);
--oc-status-success-bg: var(--ok-subtle);   --oc-status-success-fg: var(--ok);
--oc-status-warning-bg: var(--warn-subtle); --oc-status-warning-fg: var(--warn);
--oc-status-error-bg: var(--danger-subtle); --oc-status-error-fg: var(--danger);
--oc-status-info-bg: var(--info-subtle);    --oc-status-info-fg: var(--info);
--oc-font-body: var(--font-body);     --oc-font-size-base: var(--control-ui-text-md);
--oc-space-1..8: var(--space-1..8);
--oc-duration-fast/-ui: var(--duration-fast)/var(--duration-normal);
```
Source: `/home/claude/refs/openclaw/ui/src/styles/carapace-control-ui.css:25-113` (repo commit `b9421f4`).
Note: `--ok`, `--warn`, `--danger`, `--info` (and their `-subtle` variants) are referenced by the bridge but their
literal values were **not located** in the `base.css` slice read — likely defined further down in the same file
(1196 lines total, only ~600 were read); mark as a gap, not a missing feature.

### Card layout, status badges, banners — component classes (verbatim structure)
- `.oc-card`: `border: 1px solid var(--oc-component-border); border-radius: var(--oc-radius-surface); background:
  var(--oc-component-surface); box-shadow: var(--oc-component-shadow);`
- `.oc-card-interactive:hover/:focus-visible`: border/background/shadow shift + `transform: translateY(-1px)`;
  `:active` → `translateY(0) scale(0.995)`.
- `.oc-action` (buttons): `min-height: 2.5rem; border-radius: var(--oc-radius-control); font-weight: 700;`
  variants `.oc-action-primary` (accent-filled), `.oc-action-secondary` (accent-soft, with a light-theme override
  under `html[data-theme="light"] .oc-action-secondary` that switches to a bordered/elevated look instead of the
  soft-accent look), `.oc-action-ghost` (transparent).
- `.oc-banner`: `display: grid; grid-template-columns: auto minmax(0,1fr) auto; border-radius:
  var(--oc-radius-surface); background: var(--oc-surface-card-strong);` — i.e. banners use the "strong"/popover
  surface tone, not the plain card tone, and reserve a trailing grid column for `.oc-banner-action`.
- `.oc-status` / `.oc-status-indicator` / `.oc-status-label`: status badge system with `.oc-status-success`,
  `.oc-status-warning`, `.oc-status-error`, `.oc-status-info` modifier classes, each setting the indicator's
  `background` to the matching `--oc-status-*-fg` token (e.g. `.oc-status-success .oc-status-indicator { background:
  var(--oc-status-success-fg); }`).

Source: `/home/claude/refs/openclaw/ui/src/styles/carapace-control-ui.css:143-260,340-360,461-500` (repo commit
`b9421f4`). Exact pixel/gap values for `.oc-status` itself (dot size, label font) were visible in the grep context
line numbers (461-500) but not fully transcribed here — see Gaps.

### Inferences
- The `--oc-*` layer exists specifically so a plugin's Control-UI tab (like PLUR1BUS's) can theme itself purely
  by consuming `--oc-*` custom properties without needing to know which of OpenClaw's several shipped theme
  families or a user's custom theme is active — the file's own comment states this directly ("Keeping this bridge
  pointed at the resolved Control UI tokens makes every shipped theme family, mode, and imported custom theme
  work without a Carapace-side copy of the product theme catalog"). ADR-004 should treat `--oc-*` (not the raw
  `--bg`/`--accent`/etc. tokens) as PLUR1BUS's actual integration surface, since the raw tokens are OpenClaw's
  private implementation detail that the bridge exists to abstract away.
- PLUR1BUS's own compatibility doc independently confirms token stability across the two verified host versions:
  "the Control UI design tokens are value-identical [between 2026.8.2 and 2026.9.1], so the operator dashboard
  styling still matches its host" —
  `/home/claude/refs/openclaw-plur1bus-memory/docs/compatibility-openclaw.md:306`. This is a second, independent
  (PLUR1BUS-side) confirmation that the token *names* are stable across host versions, which supports building
  ADR-004 directly on the `--oc-*` names above rather than hedging heavily against drift — though note this repo
  checkout is version 2026.9.5, one point release past the last version PLUR1BUS explicitly re-verified
  (2026.9.1), so treat the *exact literal color values* above as "current as of 2026.9.5, last independently
  reverified by PLUR1BUS at 2026.9.1" rather than assuming PLUR1BUS's compatibility statement covers 2026.9.5 too.

### Gaps
- `--ok`, `--warn`, `--danger`, `--info` and their `-subtle` variants' literal color values were not located in
  the portion of `base.css` read (only lines 1-600 and 500-600 of 1196 were fetched). A follow-up read of the
  remaining ~600 lines of `base.css` is needed before ADR-004 cites literal status-badge colors.
- Exact `.oc-status`/`.oc-status-indicator`/`.oc-status-label` size/spacing values (dot diameter, label
  font-size) were not transcribed verbatim — only that they exist and which tokens back their color.
- No separate license file specific to `ui/` was found beyond the inline attribution comment in
  `carapace-control-ui.css`; the root `/LICENSE` (MIT, OpenClaw Foundation) is assumed to cover `ui/` as a whole
  since no `ui/LICENSE` override file was found, but this wasn't exhaustively confirmed by listing every
  directory for a nested LICENSE.

---

## (4) Plugin/host API summary (cross-check only)

### Takeaway
This section is intentionally thin per the task's scope note ("another researcher covers the plugin side") —
included only as a cross-check against what PLUR1BUS's own docs already claim to use.

### Cited Findings
- PLUR1BUS's own compatibility doc states host-contract stability directly: "the accepted plugin API range is
  unchanged at `>=2026.5.17`, all 42 hook names are identical, every registrar used here is present, the export
  map only gains `./plugin-sdk/blob-runtime` and `./plugin-sdk/node-cli-runtime` [between 2026.8.2 and 2026.9.1],
  the plugin config key remains the manifest id" —
  `/home/claude/refs/openclaw-plur1bus-memory/docs/compatibility-openclaw.md:301-306`.
- PLUR1BUS's declared use of host capabilities (for cross-check, not independently re-derived from OpenClaw
  source in this pass): `kind: "memory"` / `plugins.slots.memory` / `registerMemoryCapability` (exclusive memory
  slot), `registerEmbeddingProvider` + `contracts.embeddingProviders`, `registerGatewayMethod`, `registerCli`,
  `openclaw/plugin-sdk/gateway-runtime` (cron/dispatcher), typed lifecycle hooks (capture/recall/startup/shutdown),
  `registerService` (Obsidian watcher lifecycle), `skills.proposals.create`/`skills.proposals.apply` (Skill
  Workshop) — all from
  `/home/claude/refs/openclaw-plur1bus-memory/docs/compatibility-openclaw.md:29-49,69-76,144-149`.
- Confirmed from the OpenClaw source side in this pass (not exhaustive — see Gaps): the memory-core plugin itself
  (OpenClaw's own bundled dreaming plugin) uses a `CronServiceLike` abstraction with `list/add/update/remove/
  removeStaleJobFamily` for its own managed cron jobs
  (`extensions/memory-core/src/dreaming-cron.ts:73-90`, repo commit `b9421f4`) — this is the same shape of API
  surface PLUR1BUS's own docs describe using ("native cron/dispatcher path"), suggesting both memory-core and
  PLUR1BUS provision cron jobs through the same host-level cron service rather than PLUR1BUS reverse-engineering
  a separate mechanism.

### Inferences
- Because OpenClaw's own first-party `memory-core` plugin and PLUR1BUS both provision cron jobs through what
  appears to be the same `CronServiceLike`-shaped host API, ADR-009 can reasonably model PLUR1BUS's own dreaming
  scheduler after memory-core's job-reconciliation pattern (declarationKey + idempotent add/update/remove) rather
  than inventing a different provisioning strategy.

### Gaps
- Full plugin-SDK hook list (all 42 named hooks PLUR1BUS's doc references) was not independently enumerated from
  OpenClaw source in this pass — this is explicitly out of scope per the task ("another researcher covers the
  plugin side"), so it's listed here only as a gap, not a failure.
- The Control-UI plugin-tab *descriptor* API (how a plugin registers a Control-UI tab, what props/shape it
  expects) was not located in this pass; only the CSS token layer consumed by such a tab was investigated, per
  the task's actual ask for section 3.

---

## Source list (for quick reference)

| # | Source | Type | Date checked |
| --- | --- | --- | --- |
| 1 | https://github.com/openclaw/openclaw | Official repo (cloned to `/home/claude/refs/openclaw`, commit `b9421f4fa69f10404d21c5d55d07fdb0e86dff16`, v2026.9.5) | 2026-09-22 |
| 2 | https://docs.openclaw.ai/concepts/dreaming | Official docs | 2026-09-22 |
| 3 | https://docs.openclaw.ai/concepts/memory | Official docs | 2026-09-22 |
| 4 | https://docs.openclaw.ai/install | Official docs (did not contain config-path detail) | 2026-09-22 |
| 5 | `/home/claude/refs/openclaw/docs/openclaw-agent-runtime.md` | Repo-internal dev doc | 2026-09-22 (repo commit `b9421f4`) |
| 6 | `/home/claude/refs/openclaw/docs/gateway/configuration.md` | Repo-internal doc | 2026-09-22 (repo commit `b9421f4`) |
| 7 | `/home/claude/refs/openclaw/src/memory-host-sdk/dreaming.ts` | Source | 2026-09-22 (repo commit `b9421f4`) |
| 8 | `/home/claude/refs/openclaw/extensions/memory-core/src/dreaming-cron.ts`, `dreaming.ts`, `dreaming-phases.ts`, `dreaming-dreams-file.ts` | Source | 2026-09-22 (repo commit `b9421f4`) |
| 9 | `/home/claude/refs/openclaw/ui/src/styles/base.css`, `carapace-control-ui.css` | Source | 2026-09-22 (repo commit `b9421f4`) |
| 10 | `/home/claude/refs/openclaw/ui/src/app/theme.ts`, `bootstrap-theme.ts` | Source | 2026-09-22 (repo commit `b9421f4`) |
| 11 | `/home/claude/refs/openclaw/LICENSE` | Repo license | 2026-09-22 |
| 12 | `/home/claude/refs/openclaw-plur1bus-memory/docs/compatibility-openclaw.md` | PLUR1BUS repo doc | 2026-09-22 |
| 13 | `/home/claude/refs/openclaw-plur1bus-memory/docs/compatibility-openclaw-2026.8.1-beta.3.md` | PLUR1BUS repo doc | 2026-09-22 |
| 14 | `/home/claude/refs/openclaw-plur1bus-memory/docs/configuration.md` | PLUR1BUS repo doc | 2026-09-22 |
| 15 | `/home/claude/refs/openclaw-plur1bus-memory/OPENCLAW_SDK_COMPAT_AUDIT.md` | PLUR1BUS repo doc (v6-era audit, 2026-06-02) | 2026-09-22 |
| 16 | GitHub issue titles: #62920, #62296, #62857, #65412, #67922, #143206, #154153, #151866, #63465 | Web search results only, **not opened** | 2026-09-22 |
