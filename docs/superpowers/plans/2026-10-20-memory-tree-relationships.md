# Memory tree, relationship memory, confidentiality levels and multi-user roles (M3+) — implementation plan

**Goal.** An agent's memory becomes a topic tree with six fixed top branches, relationship awareness (agent × person),
three confidentiality levels, recall by zooming in, step-up verification for private content and out-of-band secret
delivery, maintenance-account roles with break-glass, and the loan/hand-over rules of D114 refined, as specified in
[`2026-10-20-memory-tree-relationships-design.md`](../specs/2026-10-20-memory-tree-relationships-design.md) (cited as
"spec §n").
**Architecture.** The engine owns the tree: node table, per-card tree/relationship/context/level fields, placements for
shared rows, structured recall with the `privat` filter in the store query, node summaries, KNOWLEDGE.md as root and the
tree-shaped mirror (engine contract 1.18.0, spec §6.4). The harness resolves the active relationship, places captured
entries and zooms through one `TreeChooser` port on the decision model role, weights and labels recall items in the
prompt builder, runs step-up ceremonies and out-of-band delivery, and extends RBAC object checks and the break-glass
registry to relationship branches.
**Status.** Plan only. Owner decisions of 2026-10-19/20 recorded (spec §18.1, **D116**); detail questions Q1–Q12 open
(spec §18.2). WP0, WP1–WP3 (engine), WP4 and WP9 are unblocked by the decisions; WP7's voice part needs P9 (a licensed
local speaker-embedding model); WP8 needs P4, P6, P7.
**Constraints.** Additive only: new RPC methods with `x-stability: "experimental"`, `x-server: "core"`, `x-since`, closed
params (AGENTS.md); no new RPC error codes; no new dependencies in the harness without the dependency gate (the speaker
model runs on the existing sherpa-onnx runtime); the engine contract change is additive (1.18.0) and pinned to an exact
commit; no direct store writes from the harness (D28/T7); secret values never in prompts, tool results, logs, traces or
the session store. No CI polling, force-push, rebase, amend or stash.

## Review focus

1. A foreign `privat` entry reaches **no** prompt, tool result, view, mirror, summary, node name, diary, log or export
   (spec §9.3, §17).
2. Secret values never pass through the model; delivery only out of band after a fresh step-up, audited in the chain
   (spec §10.4, §10.5).
3. Main users never reach another main user's agents' memories through any surface; maintenance accounts need
   break-glass for relationship branches (spec §11).
4. The engine filters by level and relationship **before** results leave it; the harness never relaxes a level.
5. Placement never leaves an entry more permissive than `vertraulich`, including after a crash (spec §7.1).
6. „Früherer Mensch: <Name>“ exactly as decided; no gendered text anywhere (spec §13, §18.1 point 11).

## Dependencies and order

```text
WP0 decisions + P1/P2 check
  ├──► WP1 engine contract 1.18 ──► WP2 engine summaries + KNOWLEDGE.md root ──► WP3 engine tree mirror
  │        │
  │        ├──► WP4 relationship resolution + registry ──► WP5 placement ──► WP6 zoom recall + weighting + prompt
  │        │                                                    │                     │
  │        │                                                    └──► WP10 dreaming tree tidy + human edits
  │        └──► WP12 migration of existing memories (after WP5)
  ├──► WP9 roles, isolation, break-glass (P5) ─────────────────────────────────────────┐
  ├──► WP7 step-up framework + text fallbacks (P5, P7) ──► voice verification (P9)     │
  │                   └──► WP8 out-of-band secret delivery (P4, P6, P7)                │
  └──► WP11 federation glue (Track F WP12/WP13 fakes) ◄── WP6                          │
                         WP13 web UI ◄── WP3–WP10 ──► WP14 CLI ──► WP15 docs           │
                         WP16 privacy suite + E2E ◄── all ◄─────────────────────────────┘
```

One branch and one **ready** PR per work package (stacked only where a WP needs its predecessor's code; then `--base
<predecessor branch>` and "baut auf #N auf"). Engine WPs are PRs in `openclaw-plur1bus-memory`; the harness repins the
engine to the exact merge commit in a separate PR before WP5.

---

## WP0 — Owner questions and prerequisite check (≈ 0.5 agent days; decisions of 2026-10-19/20 done)

**Content.** Record the answers to spec §18.2 Q1–Q12 in the spec (status lines), update `docs/milestones.md` placement
if Q1 changes it. Read harness issues #604–#609 and engine issues #254/#255 and map each to the WP it gates (table in
this plan); check P3–P9 on current `main`.
**Acceptance.** Every open question has a status; every prerequisite issue is mapped to a WP or marked independent.

## WP1 — Engine contract 1.18.0: tree, relationship, context, level (engine repo; ≈ 6 agent days; P2)

**Files (engine).** `types/engine.d.ts` (contract 1.18.0: `MemoryCard` fields, `MemoryOps.tree`, `MemoryOps.place`,
recall request/result additions, `Engine.capabilities.memoryTree`), store migration (node table, card fields with
scalar indexes, `memory_placements`, `tree_ops`), recall path (prefilter by subtree, structured items, **`privat`
exclusion for foreign relationships in the query**, own/foreign flag), capture accepting level/relationship/context/
node, `docs/engine-api.md` section "Tree in 1.18.0".
**Tests (engine).** Migration keeps every card; fixed top keys cannot be renamed/moved/deleted; move rewrites node rows
only (row count assertion); sibling name uniqueness after folding; prefilter returns only subtree hits; a foreign
`privat` card is never returned by recall, list, show or search (marker test); an invisible node is absent from
`tree.list` and answers not-found on every op; undo restores the exact previous state; no vector rewritten by any tree
op; contract version and capability reported.
**Acceptance.** Existing engine suite green; contract change additive; one store handle (T7).

## WP2 — Engine: node summaries and KNOWLEDGE.md as root (engine repo; ≈ 3 agent days)

**Files (engine).** Summary maintenance per node with the two views `shareable` and `relationship:<key>` (spec §6.2),
debounced and batched in the maintenance job, `summarize` role, local-only under `privacy.localOnly`;
`engine/knowledge/knowledge-pending.js` and the `knowledge_update` tool (`engine/tools/memory-tools.js:718`) write into
the tree and render `memory/KNOWLEDGE.md` from top-level shareable summaries plus pinned items.
**Tests.** A shareable summary never contains text of a `vertraulich`/`privat` entry (marker); a relationship summary
contains only that relationship's entries plus shareable ones; summaries refresh after capture, move, correct, forget;
KNOWLEDGE.md renders deterministically from the tree; `knowledge_update` still curates.

## WP3 — Engine: tree-shaped Obsidian mirror (engine repo; ≈ 2.5 agent days)

**Files (engine).** `lib/obsidian/memory-note-writer.js` (today flat `{reviewPath}/memories/{id}.md`, lines 4, 178, 204)
→ folder per node with `_index.md`, entry notes inside, per-viewer filtering (spec §6.3), changed-file detection with
set-aside into the archive; old flat notes moved once into the tree layout.
**Tests.** Folder names sanitised (no traversal, no reserved names on Windows); a viewer's vault never contains a
foreign `vertraulich`/`privat` marker; `privat` of the viewer's own relationship listed without text unless enabled;
a file edited in Obsidian is set aside and reported, never lost; rename/move of nodes moves folders.

## WP4 — Harness: active relationship and relationship registry (≈ 3 agent days; P5)

**Files.** `packages/core/src/memory-tree/relationship.ts` (new: resolve the active relationship per turn from
`IdentityPort.resolve`, login session, passkey session, shared-device profile pick; provisional relationship for
unlinked identities and merge on linking through the existing back-fill), `packages/core/src/session/turn-loop.ts` and
`memory-port.ts` (pass `activeRelationship`, `view`, `structured: true`; turn event records the relationship),
relationship labels (`<Agent> × <Person>`, „Früherer Mensch: <Name>“), context (`home`, `loan`, `mission`, project id).
**Tests.** Linked channel identity → its person; unlinked → provisional, merged after linking (dry-run, apply,
reverse); shared-device pick never counts as step-up; cron/internal turns have no relationship; the relationship is in
the turn event and in every recall/capture call.

## WP5 — Harness: placement at capture (≈ 3 agent days)

**Files.** `packages/core/src/memory-tree/place.ts` (new: level + node via `TreeChooser`, JSON schema
`plur1bus.memory-place/1`, one repair, deadline 2 s, stored first as `vertraulich` at the top branch then placed in one
engine transaction), `packages/core/src/memory-tree/chooser.ts` (`TreeChooser` port; backend `modelRoles.decision`
with timeout and fallback as D105 triage, later the D70 module), category fallback table (spec §7.2), override phrases
(spec §7.3), config keys `memory.tree.maxDepth`, `memory.tree.placeMaxCalls` (`x-restart: live`, `x-tier: advanced`;
`pnpm gen`, `pnpm docs:gen`).
**Tests.** Fake decision role: child pick, new node with name rules, "stay here", timeout → fallback, invalid JSON →
repair → fallback; level below 0.7 confidence → `vertraulich`; crash between store and place leaves `vertraulich`;
"bleibt unter uns" → `privat`, "darf Eva wissen" → `teilbar` (with `shareWith` per Q2); depth limit.

## WP6 — Harness: zoom recall, weighting, prompt format (≈ 4 agent days)

**Files.** `packages/core/src/memory-tree/zoom.ts` (new: parallel flat + zoom, thresholds, two branches, level timeout,
last-branch hint, active relationship only in `human`/`us`), `packages/core/src/memory-tree/weight.ts` (spec §8.3:
foreign factor, importance lift, cap), prompt rendering of labelled items in the dynamic suffix (prompt zone builder,
ADR-010) with the `VERTRAULICH` marker and the system rule (spec §8.4), safety-exception path with audit-chain event and
notification (spec §9.4), config keys `memory.zoom.*`, `memory.recall.foreignFactor|importanceLift|foreignCap`.
**Tests.** Thresholds (one/two branches/flat); deadline → flat within `core.recall.hardBudgetMs`; zoom never offers a
foreign node; weighting formula bounds (foreign ≤ 0.8 with the defaults); cap 5 of 20; prompt contains labels and
markers; an item without level is rendered as `vertraulich`; cached prefix hash unchanged by recall (B6 gate);
safety exception audited and notified.

## WP7 — Harness: step-up framework, text fallbacks, voice verification (≈ 6 agent days; P5, P7, P9)

**Files.** `packages/core/src/identity/stepup/` (new: ceremony state, verified window `identity.stepUp.windowMs`,
binding to person/surface/purpose, `identity.stepup.start|complete` RPC), fallbacks: passkey link (M3 WebAuthn, UV
required), desktop confirmation (request-hash bound, D1 local connection), pairing code (six characters, ten minutes,
one use); voice: enrollment with consent screen, template in the secret store, challenge phrase list, local STT check,
local speaker-embedding model through the sherpa-onnx runtime in `packages/voice-providers/src/local/` (new model kind
`speaker`, licence gate), threshold calibration fixture, lockout after three failures; `voice.enroll.*` RPC.
**Tests.** Fake embedding model: right speaker + right phrase passes; wrong phrase, replayed recording (same phrase
twice), other speaker fail; lockout and fallback; template never leaves the secret store (export/backup/loan package
scans); passkey/desktop/pairing-code bindings refuse a different purpose; window expiry; consent recorded and deletion
works.
**Fallback without P9.** Voice step-up stays `E_NOT_AVAILABLE` with the text fallbacks active; KNOWN GAP todo test
"voice step-up".

## WP8 — Harness: out-of-band secret delivery (≈ 3.5 agent days; P4, P6, P7)

**Files.** `secret_deliver` agent tool (status-only result) and `secret.deliver` RPC; delivery paths: channel sensitive
direct send with deletion after `secrets.delivery.ttlMs` (needs the channel adapters' new optional capability, P6),
desktop clipboard with 30 s clear (P7), one-time web reveal behind passkey; per-secret "deliverable" flag (Q7); the
secret store's audit writer teed into the audit chain (P4) and the `secret.delivered` event.
**Tests.** A probe secret delivered out of band never appears in the session store, prompts, provider requests, tool
results, traces, logs or prompt-cache keys; group chat refused; channel without deletion refused with the fallback
offered; stale step-up refused (`E_APPROVAL_REQUIRED`); non-deliverable secret refused; chain event has no value;
existing `secret get --reveal` unchanged.

## WP9 — Harness: roles, main-user isolation, break-glass on relationships (≈ 3.5 agent days; P5)

**Files.** `packages/core/src/rbac/**` (object check with the relationship view, spec §11.3; new break-glass resource
kinds "relationship branch of P" and "`vertraulich`/`privat` entry of P", notification text, step-up for the holder per
Q8), maintenance warnings at setup, `user add` and first login (web, desktop, CLI), `personOf` link per Q6, memory RPC
guards (`memory.tree.*`, `memory.place`, `memory.timeline`, existing `memory.list/show/forget/correct`).
**Tests.** Main user A cannot read B's agents' memories through RPC, web, CLI `--json`, WebMCP, exports (`E_NOT_FOUND`);
a `use` holder sees only own relationship branches (Q9); maintenance account reads agent/project `teilbar` content but
needs break-glass for relationship branches; grant, every read, expiry and revocation audited; affected person
notified; agents never obtain break-glass; warnings shown exactly at creation and first login.

## WP10 — Dreaming "tree tidy" and human edits (≈ 3 agent days)

**Files.** New dream phase in `packages/core/src/dreams/` (merge proposals by summary similarity ≥ 0.9 plus decision
confirmation, single-child collapse, never across relationships, project boundaries or visibility; diary lines without
private text; 30-day undo), `memory.tree.rename|move|merge|undo` RPC, in-conversation edit intents ("schieb das nach …").
**Tests.** Merge never joins nodes of two relationships or a project and a non-project node; a merge never makes a
hidden entry visible; diary lines carry no marker of `privat`/foreign `vertraulich`; undo restores; human edits on top
branches refused.

## WP11 — Federation glue for loan and hand-over (≈ 2 agent days; with Track F WP12/WP13)

**Files.** Interfaces Track F consumes: loan package selection hides `privat`; mission capture with the borrower's
relationship and `context.kind = mission`; mission memory batches carry `relationshipKey` and level and are imported
separated (federation Q10 precision, spec §12); hand-over package with the whole tree, relabelling to
„Früherer Mensch: <Name>“, empty new relationship, levels preserved, consent handling per Q12, undo hook.
**Tests (with Track F fakes).** Mission memories arrive separated by relationship and level; a home conversation sees
returned `privat` mission entries nowhere; relabel string exact (no gendered variant, test asserts the literal);
new relationship empty; undo restores the giver's state.
**Note.** The loan and hand-over flows themselves are built in Track F WP12/WP13; this WP delivers and tests the memory
side so Track F does not have to change it.

## WP12 — Migration of existing memories (≈ 2.5 agent days)

**Files.** Placement job (resumable checkpoint, dry-run with counts, batch size and rate limit, `plur1bus memory tree
migrate --dry-run|--run|--status`), relationship from `ownerUserId` and origin, levels per Q10, fallback top branches
per spec §7.2, progress in `1staid check`.
**Tests.** Dry run writes nothing; run is resumable after a kill; every card ends placed with a level; no card becomes
`privat`; recall quality on the fixture set not worse than flat recall (same top-5 hits or better).

## WP13 — Web UI (≈ 5 agent days; live acceptance needs M3 transport)

**Files.** `packages/web/src/pages/memory/**`: tree view with lazy children, time view, level badges and override,
rename/move/merge with undo, "Meine Beziehungen", enrollment and step-up dialogs, break-glass dialog with reason and
notice, maintenance warnings; DE/EN in the i18n bundles (append only), styles in CSS files (no inline styles).
**Tests.** Mock-server component tests; Chromium DE/EN keyboard flow: browse tree → move a node → undo → raise a level →
step-up with fake passkey; a main user's DOM contains no other person's relationship labels or markers; axe clean.

## WP14 — CLI (≈ 1.5 agent days)

**Files.** `crates/plur1bus/src/commands/memory_tree.rs` (or the memory command module): `memory tree`, `memory tree
mv|rename|merge|undo|migrate`, `memory level`, `memory timeline`, `voice enroll|forget`, `secret deliver`, every leaf
`[experimental]`, `--json` raw RPC value with `schema` id; `docs/cli.md` via `pnpm docs:gen` (cargo only where the
controller allows it).
**Tests.** clap parse tests; JSON passthrough against a fake core; exit codes per `docs/errors.md`.

## WP15 — Documentation (≈ 1.5 agent days)

**Files.** `docs/memory-tree.md` (new, operator view), `docs/identity.md` (relationships, step-up), `docs/rbac.md`
(relationship view, break-glass kinds), `docs/audit-chain.md` (new events, secret store writer), user docs DE/EN
(memory tree, levels, „bleibt unter uns“, voice enrollment) including the correction of "Sprecherkennung (`vad`)" in
[`docs/user/de/sprachfunktionen.md`](../../user/de/sprachfunktionen.md) line 15 (VAD is voice activity detection) and
its generated help bundle, `docs/milestones.md` status paragraph; owner worksheet for one real voice step-up and one
real out-of-band delivery (NOT RUN until executed).

## WP16 — Privacy suite and end-to-end (≈ 3.5 agent days)

**Files.** `packages/core/test/memory-tree/privacy-suite.test.ts`, `packages/web/test/memory-tree.test.ts`, a transport
test through the real HTTP API once M3 transport is on `main`.
**Matrix.** Spec §17: fixture agent with relationships to two persons, markers per level in entries, node names and
summaries; probed from both persons, a group chat, a project conversation, a borrower conversation, the receiver after a
hand-over; through recall, prompt, tool results, WebMCP, web/CLI/RPC views, mirror, KNOWLEDGE.md, diary, traces, logs,
exports. Expected: foreign `privat` markers nowhere; foreign `vertraulich` markers only in the marked prompt block and
never in a scripted reply; foreign `privat` ids `E_NOT_FOUND`; probe secret nowhere.
**Acceptance.** Every cell has a named test; the suite runs in CI without live models.

---

## Effort and gates

| WP | Content | Depends on | Effort (ad) |
|---|---|---|---|
| WP0 | Owner questions, prerequisite mapping (#604–#609, engine #254/#255) | — | 0.5 |
| WP1 | **Engine** contract 1.18.0: tree, relationship, context, level, structured recall, in-store `privat` filter | WP0; P2 | 6 |
| WP2 | **Engine** node summaries (two views), KNOWLEDGE.md as root | WP1 | 3 |
| WP3 | **Engine** tree-shaped mirror with `_index.md`, per-viewer filter | WP1 | 2.5 |
| WP4 | Active relationship and registry | WP1; P5 | 3 |
| WP5 | Placement at capture (`TreeChooser` on the decision role) | WP4 | 3 |
| WP6 | Zoom recall, weighting, prompt labels, safety exception | WP5 | 4 |
| WP7 | Step-up framework, text fallbacks, voice verification | WP0; P5, P7, P9 | 6 |
| WP8 | Out-of-band secret delivery, secret audit into the chain | WP7; P4, P6, P7 | 3.5 |
| WP9 | Roles, main-user isolation, break-glass on relationships | WP4; P5 | 3.5 |
| WP10 | Dreaming tree tidy, human edits | WP5 | 3 |
| WP11 | Federation glue (loan, hand-over memory side) | WP6; Track F fakes | 2 |
| WP12 | Migration of existing memories | WP5 | 2.5 |
| WP13 | Web UI | WP3–WP10 | 5 |
| WP14 | CLI | WP4–WP10 | 1.5 |
| WP15 | Documentation | WP13, WP14 | 1.5 |
| WP16 | Privacy suite and E2E | all | 3.5 |
| | **Total** | | **≈ 54 ad (43–68)**, of which engine ≈ 11.5 |

Range: −20 % if P4–P7 are delivered by their owners before the WPs that need them; +25 % if the speaker-embedding model
needs its own runtime work or the channel adapters' deletion support has to be built here.

**Gates.**
- **G1 (after WP1):** engine contract review: additive, `privat` filter inside the store query, no vector writes.
- **G2 (after WP6):** prompt format and weighting reviewed with the owner on a real conversation sample.
- **G3 (after WP7/WP8):** security review of step-up and out-of-band delivery (probe-secret scan, voice replay test,
  audit chain completeness).
- **G4 (after WP9):** isolation review: no surface reaches another main user's agents' memories.
- **G5 (WP16):** full privacy matrix green; owner acceptance with the worksheet.

**Acceptance criteria (track).**
1. Every memory has a topic path below one of the six fixed top branches; the agent creates deeper branches; dreaming
   merges duplicates; people rename, move and merge with undo; a time view exists.
2. The engine store is the source of truth; the Obsidian mirror is a folder tree with `_index.md` per node; node
   summaries stay current; KNOWLEDGE.md is the root overview.
3. Recall zooms in per level and falls back to two branches or the flat search without losing hits, inside the recall
   budget.
4. Each turn has an active relationship; recall items carry origin labels; foreign entries are discounted and capped.
5. `teilbar`/`vertraulich`/`privat` behave as in spec §9.1; a foreign `privat` entry appears nowhere (privacy suite).
6. `privat` disclosure and secret delivery require step-up; secret values never pass through the model and every
   delivery is in the audit chain.
7. Maintenance accounts are warned and reach relationship branches only by break-glass with notification; main users
   never see another main user's agents' memories.
8. Loans and hand-overs carry relationships and levels as decided; „Früherer Mensch: <Name>“ appears exactly so.

## Open points carried from the spec

Spec §18.2 Q1–Q12 (status offen); prerequisites P1–P9 (spec §16). Phase 2 (not estimated): Obsidian return path with
conflict detection (spec §6.3).

Version sequencing correction (Owner/Controller, 2026-10-20): Großpaket 3 A1 introduces contract **1.17.0** for recall
statistics, curated promotion and curation. D116 C1/WP1 therefore uses additive contract **1.18.0**. The controller
alone updates the Harness Engine pin and lockfile after the relevant Engine merge.
