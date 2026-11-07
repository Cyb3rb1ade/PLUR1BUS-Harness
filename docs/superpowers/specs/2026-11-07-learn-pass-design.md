# Learn pass: shadow review (D126 V3, D128 N5)

Status: implementation contract for package LP, 2026-11-07. Base: d0ed7970.
The owner amendment in this section supersedes the LP brief's H3 submission requirement.

## 1. Authority and scope

`learn` is a harness job attached to the existing Core DreamScheduler lifecycle. It creates no host cron,
second scheduler, agent turn, Engine job or live-memory writer. Agent, project and installation passes
are independently disabled by default. Configuration changes require a Core restart and advanced tier.
An explicit manual run still requires an enabled scope, current authorization and the same caps.

An agent target is `(owner, agentId)` and maps to `agent-private`. A project target adds `projectId`,
requires a live project and an assigned agent, and maps to workspace memory. Project membership never
substitutes for memory RBAC. Sessions must have the exact owner, remember mode, a completed non-incognito
turn in the window and target-store read rights for both principal and agent; project sessions must also
have the exact project scope. External exposure switches further narrow access. Unresolvable synthetic
owners are excluded, not guessed. D116 trees and relationship adapters are not introduced.
Review rechecks scope and source-session rights on every read and immediately before a decision.
A person cannot inspect another owner's excerpts, including with an administrative role alone.

## 2. Owner ruling: a finding review store, not a skill queue

LP owns a private review store as part of its learn ledger. It stores learning findings only. It does not
implement `SkillProposalBackend`, create SKILL.md, install, enable or replace `UnavailableSkillProposals`.
Knowledge acceptance is an authenticated human action through the existing guarded public methods:
new fact via `memory.importText.apply`, retaining its rollback receipt; correction via `memory.correct`;
duplicate/retire via `memory.forget`; changes to shared cards via `memory.propose`. A stale finding is a
hint and requires an explicit correct/forget choice. Existing method permissions and unsupported targets
remain authoritative. No agent-origin call is disguised as a person. No Engine pin changes.

Procedural findings and installation tool-error findings are read-only `waiting-h3` entries with a
count-only inbox notice. They never enter A/B precision. A future available public H3 adapter receives
these automatically at the normal job boundary, using stable finding IDs for idempotency. Without that
adapter they remain visible, never falsely reported as delivered. Existing H3 backend and tests remain
unchanged. Installation output carries no transcript references that would disclose content.

## 3. Data model and persistence

`state/dreams/learn.db` is the learn portion of the Dream ledger. SQLite migrations are forward-only;
private directory/file permissions use the existing secure-path port. Run and step rows contain only
IDs, timestamps, counters, hashes and enumerated classes. Review payloads are kept separately in the
same private database and are never serialized into logs, generic run status or inbox parameters.

Run: runId, target identity, window start/end, selection digest, prompt/calibration revision, state,
reason class, token counts, session IDs and per-step checkpoints. Unique target/window identity owns
one run; selection is frozen before analysis. Each step is recorded before external work. Crashed runs
resume the same run, reauthorize their selection and retain completed checkpoints. A single in-process
scope lock prevents concurrent production. Findings publish atomically only after the entire run
finishes within budget. Failed/budget runs expose no partial review batch. Unknown provider usage
retains its reservation and does not become a zero-token success.

Finding: stable content-derived ID, runId, knowledge/procedural kind, proposed change
(add/correct/duplicate/stale/retire), optional memory ID, proposed text, evidence references
(session/turn/message/event IDs), prevalence (n of m sessions, distinct days/agents/persons), verified
source trust, verify result, agreement result, computed score, desiredTier and effectiveTier=C,
skeptic verdict, actual model identities, prompt revision and pending/accepted/rejected/waiting-h3 state.
Only the review payload contains text. Refuted findings stay collapsed and marked in shadow review.
Decision rows bind reviewer, finding hash and outcome. Acceptance is recorded only after the public
operation succeeds; a failed or uncertain application is not an accepted precision sample. A pending
operation receipt is reconciled before retry, never blindly replayed after a crash.

## 4. Selection, prompts and deterministic aggregation

Default window: seven days; maximum 50 sessions/run. Hard configurable ceilings bound sessions, tokens,
messages, events and findings. Content exceeding a cap defers the run visibly rather than silently
truncating evidence. Session extraction is sequential (one fresh bounded subagent context per session)
so concurrency is bounded by construction. Completed checkpoints avoid duplicate model work on resume.

Prompts are versioned files for extraction, skeptical review and wording. System instructions are
separate from a JSON data envelope. Transcripts, tool outputs and repository bytes are explicitly
untrusted data. Models can return evidence IDs, never certify source trust, actor identity or permissions.
Person-origin evidence is resolved from stored user messages; externally originated sessions and tool
outputs are untrusted unless independently verified. Instruction-like findings are always desired C.

Aggregation is code: normalize keys, sort, exact-key cluster, deduplicate evidence IDs, count prevalence
and rank with deterministic tie-breaks. The same records in any session order yield identical output.
The extractor selects a claim vocabulary key; it supplies no counts, confidence score or ranking. Existing-memory agreement
is read-only and scoped; lack of evidence is unknown, never agreement.

## 5. Verify, skeptic, route and budgets

Project verification exposes only `file.read` and `file.list`, anchored to the trusted repository root,
with bounded bytes/entries, no symlink traversal and no writes or execution. Config verification uses
only an explicitly safe redacted view. Non-project findings record `not-applicable`. Contradictions
are explicit. Verification cannot turn arbitrary tool output into person evidence.

Extraction uses configured D105 small/medium profiles, skeptical review and wording large profiles,
through the ordinary ProviderRouter. No DecisionService, triage call, Jev client or paid test call.
The configured local-only rules apply before every attempt and fallback. Missing local route records
`skipped:local-only`; missing class route records `skipped:no-model`. Calls reserve and settle tokens
through `budget/` with agent/project attribution and the additional per-run cap. Exhaustion records
`skipped:budget` and publishes nothing. The learn breaker is independent, persistent and bounded to
one UTC day; failure classes never contain provider text.

Desired A/B candidates get a skeptic context containing only the finding, authorized evidence and
verify result. `holds`, `refuted`, `insufficient` are closed verdicts. In shadow mode all three remain
reviewable as C; insufficient cannot authorize automation. Wording cannot change evidence, action,
target or trust. Invalid structured output fails the step without a partial proposal.

## 6. Score and calibration

Score inputs: sessions/days breadth, distinct agents/persons, verified source trust, verification,
existing-memory agreement and change type. Without person-origin or independently verified evidence
score is exactly zero. A: agent facts/duplicates/verified stale, score >= .8, at least three sessions
on two days. B: project knowledge, score >= .9, at least two agents/persons. Person-authored memory
changes, relationship/private content, instruction-like changes, skills and non-duplicate deletion
remain desired C. The source/target properties are host verified, never accepted from a model.

Calibration is pooled per owner and versioned by model classes, prompt revision and score policy; actual model IDs remain metadata, with thresholds A=.8/B=.9,
minimum 50 decisions per desired tier and precision >= .95. Precision is accepted/decided from actual
human decisions; pending, failed, procedural and metadata findings are excluded. Gate order is
`shadow-incomplete`, `precision-below-gate`, then `revert-unavailable`. LP never enables A/B even when
precision passes: V2 preconditions/revert, the objection window and revert breaker are future work. LQ2 adds shadow predictions without automatic changes.

## 7. Surfaces and tests

Configuration under `dreams.learn`: scoped enabled targets/owners, focus, windowDays, maxSessions,
maxTokens and fixed safety ceilings. Every node has x-restart=core and x-tier=advanced. RPC additions
are experimental closed-parameter `dreams.learn.run|status|list|get|decide|rollback|calibration`, at the
next available minor. Human-only authorization, API allowlist, WebMCP classification and Rust inventory
must agree. CLI under `plur1bus dreams learn`; web review in Memory/Dreams, DE/EN labels, collapsed
refuted findings, explicit waiting-H3 states, evidence/prevalence/score/desired tier and real decisions.

Tests use fake providers and temporary repositories/databases only: owner/project/ACL/exposure selection,
injection and untrusted score zero, deterministic permutation golden, verify capability/path isolation,
skeptic verdicts, local-only/no-Jev routing, budgets without partial publish, idempotency/restart,
real human decision accounting and all gate reasons, metadata/log/ledger/inbox marker exclusion,
public-operation acceptance/rollback and unchanged H3 backend behavior. Local lint, relevant package
suites, docs generation/check and Rust fmt/clippy/CLI tests precede the single ready PR. No CI polling.

## Interim review rulings (2026-11-07)

- Ruling H3: Channel person evidence requires persisted host-origin metadata for a direct chat,
  the session owner's exact identity, and a currently active identity link created no later than
  the turn. Historical messages without that proof, ambiguous accounts and group messages stay
  untrusted. This prevents sender inference from content or chat ownership; the cost is that old
  channel turns cannot retrospectively become trusted learning evidence.
- Ruling M1: Use an explicit bounded claim-key vocabulary carried between isolated session
  extractions, not an embedding dependency. Existing-card changes cluster by kind, action and
  memory ID; additions cluster by the selected content key. Code deduplicates evidence, counts
  sessions/days and ranks clusters. The cost of a wrong key assignment is a visibly wrong cluster
  for human review, never additional authority or automatic adoption. Prompt revision is learn-2.
- Ruling M2: Finding identity is target plus normalized content key, independent of run IDs.
  Pending findings accumulate evidence. Rejected findings reopen only for a new reference from
  a later evidence day, with a new review revision linked to the previous content-free decision.
  Precision counts only the latest decision per stable finding, so repeated weekly observations
  cannot inflate the sample. This sacrifices independent-event sampling in favor of deduplication.
- Ruling L1: Calibration pools by owner, desired tier and revision of model classes plus prompt
  and score policy. It does not reset for each agent or actual model ID. Actual serving models
  remain listed in the record for inspection. Different owners and class/prompt revisions are
  never pooled. This makes the 50-decision minimum useful; the cost is that a weaker model within
  a class can be masked by the pool, which must be assessed before V2 enables any automatic tier.
- Known limit L2: conservative instruction-word matching can keep harmless statements in C.
  This is intentional during shadow evaluation; precision does not imply recall of eligible facts.

- Ruling LP6: Existing public MemoryOps remain authoritative, including refusal of a new project
  fact because importText v1 has no workspace target. Such findings remain pending with
  unsupported-target; they are never silently redirected to agent/user memory. Existing shared
  card corrections use memory.propose. The cost is delayed project-add acceptance until the
  public operation supports that scope; LP introduces no Engine or RBAC exception.
- Ruling LP6 scheduling: enabled learning targets use one daily UTC window ending at midnight,
  with the existing Dreams timer and global concurrency semaphore. Manual execution uses that
  same window and guards. This makes retries idempotent; data from the current partial day is
  evaluated in the next window rather than generating overlapping manual runs.

LP7-Ruling: Fehlerklassen kommen ausschließlich aus dem vertrauenswürdigen Dispatcher,
Argumentformen enthalten nur Typzähler, keine Schlüssel oder Werte. Alte Tool-Resultate
bleiben unberücksichtigt, weil sich Host-Provenienz nicht aus deren Text rekonstruieren
lässt. Kosten: Die installationsweite Beobachtungsbasis wächst erst ab dieser Revision.
H3 bleibt ein unverdrahteter öffentlicher Capability-Port am heutigen Pin; erst ein
vorhandener Engine-Vertrag darf den Adapter liefern, keine Engine-Internals oder Ersatzqueue.

LQ1-Ruling: Auch der Verlust nur eines Belegs zieht den gesamten abgeleiteten Befund
zurück, weil sich sein Text nicht sicher einem einzelnen verbliebenen Beleg zuordnen
lässt. Kosten: Ein weiterhin zutreffender Befund benötigt erneute Extraktion und Prüfung.
Wiederaufnehmbare Budget-/Providerstopps sind keine endgültigen Abbrüche und behalten
Checkpoints innerhalb der maximal siebentägigen Frist. Backups enthalten learn.db;
Support-Bundles niemals. Entscheidungen bleiben ohne Befundtext erhalten.

LQ2-Ruling: „Seltener“ wird in dieser Schattenphase konservativ als kein erneutes
Signal im vollständig beobachteten Fenster gewertet, passend zu den Abnahmetests.
Kosten: Auch eine deutliche, aber nicht vollständige Verbesserung bleibt unbestätigt.
Nur lückenlose, ungekappte Fenster können bestätigen; mindestens zehn verschiedene
Sessions mit Aktivität nach der Annahme und 14 Tage müssen gemeinsam vorliegen.
Wiederholte Befunde werden vor der Review-Deduplizierung gezählt. Der Retire-Vorschlag
führt zur bestehenden manuellen Kuration, nicht zu einer neuen automatischen Mutation.
