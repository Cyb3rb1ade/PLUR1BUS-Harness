# RE-13 — Harness surfaces for three dropped adapter functions

**Package.** Three functions the OpenClaw adapter delivered through Telegram and the Obsidian control room are dropped
with the adapter ([`MODULE-MAP.md`](MODULE-MAP.md)) and had no harness counterpart: the confirmation of critical
memories, the acceptance of skill-miner proposals, and the morning and evening review. This brief gives each a harness
surface: an engine operation over RPC, an inbox entry, a CLI command, and for the review an engine job. Size M; three
tasks, one pull request each. Phase 2: starts after the Phase 1 exit (RE-09 T5 report green). Decided by the owner on
2026-10-24 (plan §1.7).

**Depends on.** Phase 1 complete: RE-05 (the critical state and `lib/critical-review.js`), RE-06 (job registry,
skill-miner ledger, the expire path of `auto-accept-stale`), RE-07 (MemoryOps error codes), RE-08 (`engine.event`,
`EngineClient`, the schema's `x-server: "engine"`). Harness: the inbox (`docs/inbox.md`), the X1 extension pipeline
(`docs/extensions.md`), the system-jobs runner and the cron evaluator (`packages/core/src/system-jobs`,
`packages/core/src/dreams/cron.ts`). **Enables.** RE-11 (no user-facing memory function of the adapter is left behind).

**Assumes.** RE-D1 (process + RPC); RE-D5 answered "go" for RE-06 (the skill-miner ledger and the job registry exist).
The Obsidian decision RE-07 T7b is independent: T3 delivers the review without a vault; when the bridge is enabled,
T7b writes the same document into the vault.

**Read first.**
- Plan §1.7 and the MODULE-MAP rows that name RE-13; `docs/inbox.md` (kinds are a closed set, `settled`, audience,
  dedupe key), `docs/extensions.md` (an unsigned folder skill, `ext.install` and its acknowledgments, the trash,
  `skills/index.json`), `docs/rbac.md` (which roles may decide), `docs/recurring.md` and `packages/core/src/system-jobs`
  (how a scheduled harness job runs), `docs/dreams.md` (the cron evaluator with IANA time zones; never a host cron),
  `docs/cli.md` `memory proposals` (the accept/reject CLI pattern, D31), AGENTS.md on `--json` (ruling R13).
- Engine files, `main` at `98dfe2f`:

| Task | Files | What they hold |
|---|---|---|
| T1 | `lib/critical-review.js` (445, ported by RE-05); `lib/db-adapter.js:1176` (`findUnconfirmedCritical`, `markConfirmed`, `markCriticalRejected`); `lib/jobs/auto-accept-stale-criticals.js:75` (`expireStaleCriticals`: since 7.16.10 an unconfirmed critical expires to a normal note); `engine/jobs/internal-job-bodies.js:241-310` (`classify-recent`: the `criticalPush` config, `hideTypes`, `buttons`, the push after classification); `lib/critical-buttons.js` (122, dropped: one Telegram message per card with Accept and Reject, `criticalDecisionLine`); `lib/critical-push-state.js` (85, dropped: the per-agent daily counter) | type labels, previews with secret suppression, short refs, the Accept / Reject (non-destructive) / Edit semantics, the state columns, the expiry |
| T2 | `lib/jobs/skill-miner/proposal-writer.js` (ported by RE-06 T5: `skill-proposals.jsonl`, `skill-rejected.jsonl`, `markProposalStatus`, `patchProposal`, `getPendingProposals`, `recordPresentation`), `skill-md-renderer.js` (`renderSkillMd`), `nudge-renderer.js`; `lib/telegram-commands/skill-commands.js` (831, dropped) for the semantics: `activateSkillProposal` (:253, `pending_review` or `activation_partial` → render `SKILL.md` → `activation_partial` → evidence → `active`), `rejectSkillProposal` (:506), `retireActiveSkill` (:667, removes only a miner-written skill folder, then `rejected` and the name blocked), `listPendingProposals` (:712), `buildSkillReviewPayload` (:747) | the ledger and its status transitions; the OpenClaw Skill Workshop binding (`openClawWorkshop`) is host-specific and not ported |
| T3 | `lib/obsidian-control-room.js:593-608` (the `morningReview` and `eveningReview` config), `:1276-1374` (`renderReviewBundleMarkdown`: lead, summary, warnings, blocked, conflicts, stale, project updates, hygiene, tasks), `:1445-1600` (`prepareReviewBundle` and `runMorningReview`: maintenance-light → items → adversarial-light → dedupe → bundle → write → notify → await approval); `lib/review-narrative-lead.js` (95, **port**: a deterministic, mood-aware lead, no LLM); `lib/review-workspace-status.js` (167, **port**: daily note, dream diary, REM report and KNOWLEDGE.md queue freshness); `openclaw.plugin.json` `configSchema.morningReview` / `eveningReview` | the digest half of the review; the vault-change half (proposals, bundle layout, apply flows) is RE-07 T7b |

**Rules that apply.** Every decision a person takes goes through the core's RBAC guard (`docs/rbac.md`): the engine
never authenticates, it receives the principal. A critical memory's preview never shows a secret and never the content
of a hidden type (`criticalPush.hideTypes`, default `zugang_passwort`). A skill proposal becomes a skill only through the
X1 install pipeline (`ext.install` from a folder, trust `unsigned`), never by writing into `<home>/skills/` directly;
retiring removes only what the miner installed. The review is a digest: it proposes, it never applies (`applyMode:
manual` stays the only value). Inbox entries carry metadata only (`titleKey`, scalar params, `ref`), never memory text.
Every new RPC method carries `x-server`, `x-stability: "experimental"` and `x-since`; the three new inbox kinds join the
closed set in the schema and the web page in the same PR. No Phase 1 golden changes: none of the three touches recall,
capture or an existing job's output; `daily-review` is a new job name, so RE-06's "nineteen specs" acceptance becomes
twenty in T3's PR.

## Files

- Create: `crates/plur1bus-engine/src/ops/critical.rs` (T1), `src/ops/skill_proposals.rs` (T2),
  `src/jobs/bodies/daily_review.rs` and `src/jobs/review/{lead,workspace_status,render}.rs` (T3);
  `packages/core/src/engine/{critical,skill-proposals,review}.ts` (forwarders and inbox producers);
  `crates/plur1bus/src/commands/{memory_critical,skill_proposals,review}.rs`; tests
  `crates/plur1bus-engine/tests/{critical_ops,skill_proposals,daily_review}.rs`,
  `tests/system/{critical-review,skill-proposals,daily-review}.test.ts`.
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (the methods below; inbox kinds `memory-critical`,
  `skill-proposal`, `review`), `packages/core/src/inbox/producers.ts`, `packages/web/src/pages/inbox` (the three kinds,
  title keys, routes), the CLI tree (every new leaf `[experimental]`), `docs/inbox.md`, `docs/extensions.md` (mined
  skills), `docs/recurring.md` (the review schedule), `docs/config-engine-keys.md` (the note on `session` and
  `writeReviewBundle`), AGENTS.md rows, RE-06's acceptance count; generated `docs/rpc.md` and `docs/cli.md`.

## Interfaces

**Consumes:** RE-05's critical helpers and RE-02's row operations (`confirmed`, the rejected mark); RE-06 `JobRegistry`,
`JobBody`, the skill-miner ledger; RE-07's `MemoryOpErrorCode`; RE-08 `engine.event` and `EngineClient`; the core's
`InboxPort`, RBAC guard and `forwardToEngine` (RE-10).

**Produces** (RPC, `x-server: "engine"` unless noted):

```text
engine.memory.critical.list     { agentId }                                   → { pending: [{ id, ref, type, typeLabel, reason, preview | null, sourceRole, createdAt, expiresAt }] }
engine.memory.critical.decide   { agentId, ref, decision: "accept" | "reject" } → { id, status: "confirmed" | "rejected" }
engine.skills.proposals.list    { agentId, status? }                          → { proposals: [{ id, skillName, skillTitle, status, evidenceCount, createdAt }] }
engine.skills.proposals.show    { agentId, id }                               → { proposal, skillMd }
engine.skills.proposals.stage   { agentId, id }                               → { folder }        renders SKILL.md into <state_dir>/skills-staging/<name>/; status activation_partial
engine.skills.proposals.activated { agentId, id, skillPath }                  → {}                status active; the evidence memories get their epistemic status
engine.skills.proposals.reject  { agentId, id }                               → {}                rejected; the name goes to skill-rejected.jsonl
engine.skills.proposals.retire  { agentId, id }                               → { skillPath }     rejected + retiredAt; the core uninstalls
engine.jobs.run { job: "daily-review", agentId, params: { profile: "morning" | "evening" } }      the existing method, a new job
engine.event { name: "memory.critical.pending" | "memory.critical.settled" | "skill.proposal.pending" | "skill.proposal.settled" | "review.ready", payload }
```

Core (`x-server: "core"`, RBAC-guarded, forwarded after the guard): `memory.critical.list | decide`,
`skill.proposals.list | show | accept | reject | retire` (accept = `stage` → supervisor `ext.install { source: { path:
folder } }` with the acknowledgments `unsigned` and `capabilities` the person gave → `activated`; retire =
`ext.uninstall` → `retire`), `review.list | show { date, profile }` over `<state_dir>/reviews/`.

CLI: `plur1bus memory critical list | accept | reject <ref> --agent <id>` (`memory.critical.list/1`,
`memory.critical.decide/1`); `plur1bus skill proposals list | show | accept | reject | retire <id> --agent <id>`
(`skill.proposals.<leaf>/1`; `accept` outside a terminal needs `--yes`, X1-C25); `plur1bus review list | show
[--profile morning|evening] [--date YYYY-MM-DD]` (`review.list/1`, `review.show/1`). Every `--json` document is the raw
RPC value (ruling R13).

Inbox: `memory-critical` (one entry per card, audience Owners and Admins, severity `warning`, params `agentId`,
`typeLabel`, `ref`, `expiresAt`; settles on `decide` or expiry), `skill-proposal` (one per proposal; settles on accept,
reject or retire), `review` (one per profile and day, severity `info`, `ref.route` `/reviews/<id>`). The entry replaces
the Telegram message, the daily counter of `critical-push-state.js` and the skill-miner nudge: the dedupe key is the
card or proposal id.

Config: `criticalPush.hideTypes` respected; `criticalPush.buttons` accepted and ignored. `morningReview.{enabled, cron,
timezone}` and `eveningReview.{…}` schedule the review through the harness scheduler; `delivery: announce` creates the
inbox entry, `silent` writes the file only; `session` and `writeReviewBundle` have no counterpart (vault writing is
T7b) and are accepted and ignored, with a note in `docs/config-engine-keys.md`.

## Tasks

### T1 — Critical-memory confirmation (one pull request)

- [ ] **Step 1: failing tests.** Engine `tests/critical_ops.rs`: `pending_criticals_list_with_short_refs_and_safe_previews`,
      `a_hidden_type_has_no_preview`, `decide_accept_marks_confirmed_and_emits_settled`,
      `decide_reject_marks_rejected_and_never_deletes`, `an_expired_card_settles_its_entry`. Core:
      `a_pending_critical_creates_one_inbox_entry_per_card`, `a_viewer_cannot_decide` (RBAC). CLI:
      `memory_critical_accept_prints_the_raw_rpc_value`.
- [ ] **Step 2: implement** the engine ops over RE-05's helpers and the row operations the Node adapter uses
      (`markConfirmed`, `markCriticalRejected`); `classify-recent` emits `memory.critical.pending` where the Node body
      called `pushCriticalButtons`; the expire path emits `memory.critical.settled`.
- [ ] **Step 3: core and CLI** — producer, forwarders, the RBAC rule (Owner and Admin decide), the web inbox kind, the
      three CLI leaves.
- [ ] **Step 4: system test** `tests/system/critical-review.test.ts`: capture a `person` card with the flat embedder,
      run `classify-recent`, see the entry, accept through the CLI, the entry settles, the card is confirmed.
- [ ] **Step 5: docs** (`docs/inbox.md`, generated docs). **Commit** `RE-13/T1: critical-memory confirmation through
      inbox, RPC and CLI`.

### T2 — Skill-proposal acceptance (one pull request)

- [ ] **Step 1: failing tests.** Engine `tests/skill_proposals.rs`: `stage_renders_skill_md_byte_identical_to_the_node_renderer`
      (golden recorded from `renderSkillMd`), `accept_requires_pending_or_partial`, `reject_blocks_the_name_for_the_miner`,
      `retire_removes_only_a_miner_written_skill`, `evidence_memories_get_their_epistemic_status_on_activation`. Core:
      `accept_installs_through_ext_install_as_an_unsigned_local_skill`,
      `a_failed_install_leaves_the_proposal_partial_and_the_staging_folder_removed`. CLI:
      `skill_proposals_accept_needs_yes_outside_a_terminal`.
- [ ] **Step 2: implement** the engine ops over RE-06 T5's ledger with the status transitions of `skill-commands.js`,
      without the Workshop binding.
- [ ] **Step 3: core and CLI** — `skill.proposals.accept` = `stage` → supervisor `ext.install` (folder → unsigned
      `local/<name>`, acknowledgments from the person's `--yes`) → `activated` with `<home>/skills/<name>/SKILL.md`;
      retire = `ext.uninstall` → `retire`; the inbox kind; the skill-miner nudge (RE-06 T5) becomes the entry's title
      params.
- [ ] **Step 4: system test** `tests/system/skill-proposals.test.ts`: a recorded miner proposal → list → accept →
      `plur1bus skill list` shows the skill with provenance `package: local/<name>` → retire → gone, name blocked.
- [ ] **Step 5: docs** (`docs/extensions.md` "mined skills", generated docs). **Commit** `RE-13/T2: skill-proposal
      acceptance through the X1 pipeline`.

### T3 — Daily review as an engine job (one pull request)

- [ ] **Step 1: failing tests.** Engine `tests/daily_review.rs`: `morning_profile_renders_the_golden_digest` (fixture
      store: counts, pending criticals, pending proposals, hygiene findings, consolidation report, dream diary pointer),
      `the_lead_matches_the_node_narrative_lead_for_each_mood` (golden of `buildReviewNarrativeLead`),
      `workspace_status_matches_the_node_module` (golden of `collectReviewWorkspaceStatus` on a fixture workspace),
      `evening_profile_adds_workspace_status`, `the_review_never_applies_anything`. Core:
      `the_schedule_runs_morning_and_evening_in_the_configured_time_zone`,
      `announce_creates_an_inbox_entry_and_silent_does_not`.
- [ ] **Step 2: implement** `jobs::bodies::daily_review` (the twentieth job; `JobSpec.default_schedule` from
      `morningReview.cron` and `eveningReview.cron`; harness and manual triggers only) and `jobs::review::{lead,
      workspace_status, render}` (the two ports). Sections: lead; summary (captured, forgotten and shared counts since
      the last review); critical pending (T1); skill proposals pending (T2); conflicts resolved
      (`conflict-resolved.jsonl`); the consolidation report; the dream diary pointer; hygiene (maintenance-light findings
      that need no vault: duplicates, stale reminders, unconfirmed criticals older than the expiry); workspace status
      (evening). The document is written to `<state_dir>/reviews/<yyyy-mm-dd>-<profile>.md` plus `.json`; `review.ready`
      is emitted.
- [ ] **Step 3: core and CLI** — the schedule in `system-jobs` from the two config keys (harness scheduler, ADR-009),
      `review.list | show`, the inbox producer, the CLI leaves.
- [ ] **Step 4: system test** `tests/system/daily-review.test.ts`.
- [ ] **Step 5: docs** (`docs/recurring.md`, `docs/config-engine-keys.md`, RE-06's acceptance "twenty specs").
      **Commit** `RE-13/T3: daily review as an engine job`.

## Acceptance

- The three system tests green with `PLUR1BUS_ENGINE_IMPL=rust`; `pnpm docs:check` green.
- No Phase 1 golden changed (RE-09's report unchanged); `engine.jobs.list` returns twenty specs, the twentieth
  `daily-review`.
- Every new CLI leaf `[experimental]` with a `--json` schema id; every new method `x-stability: "experimental"` with
  `x-since`; the three inbox kinds in the schema and the web page.
- MODULE-MAP: the two RE-13 rows have Rust modules; the four dropped rows that name RE-13 keep their disposition.

## Out of scope

Channel delivery of inbox entries (the switchboard has no outbound announcement path; when it gets one, every kind
benefits); the OpenClaw Skill Workshop binding; the vault half of the review (bundle layout, vault-change proposals,
apply flows: RE-07 T7b); a web page per surface beyond the inbox kinds; "edit" of a critical card (reject plus a new
capture through the normal path).

## Hand-off

Three PRs, independent of each other after the Phase 1 exit; T1 first (smallest, and T3 shows its count). Each PR
carries the system test it ran and, for T2 and T3, the goldens recorded from the Node modules named above.
