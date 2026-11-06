# D126: Memory versions, write preconditions and a learning pass over transcripts

**Status.** This plan records an owner decision; there is no product code yet. Decided 2026-11-06.

**What it changes.** D126 amends ADR-009 (a new dream job), D116 §5.3/§6.4 (preconditions on tree operations) and the
engine contract (the next free minor at implementation time).

**Executors.**
- Engine tasks: engine repository; the owner merges them.
- Rust parity: `crates/plur1bus-engine`; the owner merges it.
- Harness tasks: Sonnet.

**Effort.** About 11 agent-days in all.

## 1. Background

The owner asked which principles of a talk PLUR1BUS needs. The talk was Lamis (Anthropic, Applied AI), "Context engineering → Dreaming", at AI DevCon 2026. Its principles:

- Do the simple thing first: a context file, skills with progressive disclosure, memory the agent writes itself.
- In production, add:
  - **versioning**: author, session and time on every change, plus rollback;
  - **concurrency**: a hash taken before and after drafting; on a mismatch, reload, redraft and retry;
  - **permissioning**: organisation knowledge read-only, the agent's own notes read-write;
  - **portability**.
- Add **dreaming**: an out-of-band batch process with its own budget. It works as follows:
  - It reads session transcripts *including tool calls*. An orchestrator runs one subagent per session.
  - It finds recurring patterns across sessions and agents, such as the same mistake, a broken tool configuration or missing knowledge.
  - It proposes memory changes, each with example transcripts and a prevalence count. A person accepts or rejects them.
  - The transcript selection mirrors the permissions of the target store.

Most of this already exists in PLUR1BUS (§2). Three gaps are adopted here.

## 2. State on `main` (verified 2026-11-06)

**Already covered.**
- **Permissioning:**
  - scopes and ACL, including the Lens ACL fix;
  - memory exposure (ADR-003, 2026-10-29) and the D116 levels;
  - shared memory changes only through `memory.propose` plus a human `memory.proposals.accept`;
  - `forget`, `correct` and `share` refused from a non-user origin (E1).
- **Portability:** RPC and API, CLI, web, `memory.importText`/`memory.exportText`, backup, the Obsidian mirror.
- **Simple first:**
  - skills with frontmatter and `capabilities.search`/`skill.load` (D69/D103);
  - `memory.recall`/`memory.capture`, with automatic capture after every turn.
- **Storage:** D116 T2 keeps the database as the source of truth. The talk's closing question ("are we reinventing databases?") supports that.

**The engine already stores a version chain and its provenance.**
- Fields on every memory row (`crates/plur1bus-engine/src/store/row.rs`, the compatible port of the Node engine's store schema): `version_number`, `previous_version`, `superseded_by`, `version_created_at`, `update_source`, `update_evidence`, `stored_by`, `source_turn_id` and `epistemic_status_actor`.
- `correct` supersedes the old row and returns a new live id (`MemoryCorrectResult`, contract 1.5.0).
- No API exposes the chain: the `memory.*` RPC methods have no history and no revert.

**No write precondition.**
- `memory.correct` takes `caller, agentId, id, text` and nothing else.
- In the Node engine, `correctCard` (`lib/telegram-commands/memory-edit.js`) only refuses `deleted` (`getCard` has no status filter). A `superseded` id therefore passes.
- So two writers that both read the same version can each correct it. The likely result is two successors of one row: a fork, or a silent lost update. V1 confirms this by test first.

**Dreaming (ADR-009).**
- It runs per agent, on captured cards, through engine jobs.
- It finds duplicates only by content hash.
- It treats a memory as stale only by age (72-hour candidate expiry, `auto-accept-stale`).
- It does not analyse transcripts or tool calls, and it has no view across a project or a group of agents.

**The harness has the inputs.**
- `state/sessions.sqlite` holds `messages`, `events` (tool calls and results), `turns` and `path_rewinds`.
- Skill mining exists (`packages/core/src/skill-mining/`: `miner.ts`, `evidence.ts`, `review.ts`).
- Proposals (`memory.propose`, `memory.proposals.*`) and curation (`memory.curation.*`) are already human review queues.

**D116 tree operations** (op log, 30-day undo) are specified but not built.

## 3. Decision (owner, 2026-11-06)

### 3.1 Write preconditions (V1)

1. **Only the live head is writable.** Every mutating memory operation (`correct`, `forget`, `share`, `propose`) addresses the live head of a chain.
   - A superseded id is refused with a new `MemoryOpError` code `conflict`, carrying `headId` and `headVersion`. The ACL rules of `show` apply: no oracle for invisible rows.
   - The harness maps it to the existing `E_CONFLICT`, with `headId` in the error data.
2. **Optional `expectedVersion`** (the head's `version_number`) on the same operations.
   - A caller that read the text and drafted a change passes it.
   - On a mismatch the result is `conflict`, as in point 1.
3. **Retry rule** for agents and for the learning pass: reload the head, redraft, and retry once. A second conflict goes to the person, never a silent overwrite.
4. **D116 tree operations** (`rename`, `move`, `merge`, `place`) carry `expectedRevision` per node in the same way, along with the tree tidy job of D116 §5.3.

### 3.2 Visible version chain (V2)

1. **`MemoryOps.history(id, principal, agent)`** returns the versions of a chain, newest first.
   - Fields: `id`, `version`, `text`, `status`, `createdAt`, `updateSource`, `actorKind` (`person | agent | dream | import`), and `sessionId`/`turnId`/`evidence` where recorded.
   - Visibility follows `show`.
2. **`MemoryOps.revert(id, toVersionId, principal, agent, expectedVersion?)`** writes a new head with the old version's text and `update_source: "revert"`.
   - The origin rules are those of `correct`: user origin only, no agent or background origin.
   - Nothing is deleted.
3. **Every writer records its source.**
   - Dream jobs write `update_source: "dream:<phase>:<runId>"`.
   - Imports write `"import:<runId>"`.
   - Agent writes carry session and turn.
   - `actorKind` is derived from these. A V2 test fixes the vocabulary.
4. **Surfaces.**
   - RPC: `memory.history` (read class, beside `memory.show` in `DEFAULT_READ_METHODS`) and `memory.revert` (the WebMCP exposure class of `memory.correct`).
   - CLI: `plur1bus memory history|revert`.
   - Web: version list on the card view.

### 3.3 Learning pass over transcripts (V3)

A new dream job, `learn`. The harness owns it, because the transcripts live in the harness.

1. **Scope.** It runs per project (D115/D124) by default, or per agent group. It is off by default and enabled per project.
2. **Input.**
   - The transcripts of a window: messages, tool calls and results, rewinds, and outcomes such as review verdicts and verification failures.
   - The selection mirrors the target store's rights: only sessions whose agent and principal may read the target; D116 levels respected; no `privat` content crossing relationships.
   - The selection is recorded in the run ledger.
3. **Analysis.** An orchestrator runs one subagent per session, bounded by a session cap and a token budget. It looks for:
   - repeated tool errors of the same class;
   - the same correction by the person across sessions;
   - missing or contradicting knowledge;
   - rewinds with lessons (CX1).
4. **Verify step.** Project memories are checked read-only against the current repository and configuration (`file.read`/`file.list` only, no execution). Contradicting duplicates are flagged.
5. **Output: proposals only.**
   - Declarative findings go to `memory.proposals` for shared or project memory, or to `memory.curation` for the agent's own memory.
   - Procedural findings go to the skill-mining review (H3) as skill or tool-configuration proposals.
   - Each proposal carries:
     - evidence: session and turn references, with excerpts only where the viewer may read them;
     - prevalence: n of m sessions, and how many agents;
     - the proposed change: add, correct or retire.
   - Nothing is applied automatically.
   - On acceptance, writes go through V1 (precondition) and V2 (`update_source: "dream:learn:<runId>"`).
6. **Steering.** An optional focus text per project says what matters and what does not.
7. **Cost and guards.**
   - Tokens only, with no money dimension (ADR-009 amendment 2026-10-19).
   - Its own breaker and idempotency key, as in ADR-009.
   - The model route is the one rem/deep use (the configured role or a local model). Never Jev (D125): transcripts are full content.

## 4. Tasks

| Task | Scope | Where | Estimate |
|---|---|---|---|
| **V0** | This plan; amendment notes in ADR-009 and the D116 spec | `docs/` | done in this PR |
| **V1-E** | Head check and `expectedVersion` on `correct`/`forget`/`share`/`propose`; `MemoryOpError` `conflict` with `headId`/`headVersion`; contract minor; tests in §5 | engine repo (Node) | 1.0 |
| **V1-R** | Same behaviour in the Rust engine: `contract/memory_ops.rs`, `schema/engine-contract.schema.json`; parity test against the Node vectors | `crates/plur1bus-engine` | 0.5 |
| **V1-H** | RPC: optional `expectedVersion` on the four methods (next free RPC minor at implementation time); `E_CONFLICT` with `headId` in error data; CLI and web message "changed meanwhile, reloaded"; pin bump after V1-E | `packages/rpc-schema`, `packages/core`, `crates/plur1bus`, `packages/web` | 0.5 |
| **V2-E** | `history` and `revert`; `update_source` vocabulary for dream and import writers; tests | engine repo | 1.0 |
| **V2-R** | Rust parity for V2 | `crates/plur1bus-engine` | 0.5 |
| **V2-H** | `memory.history`/`memory.revert` RPC, CLI, web version list; WebMCP classes and `exposure-matrix.test.ts` | harness | 1.0 |
| **V3-0** | Design section for `learn`: data model of findings, prompts, budgets, selection rules, `dream_run` ledger fields, the H3 interface | `docs/superpowers/specs/` | 0.5 |
| **V3a** | Transcript selection with ACL mirroring, window, caps, breaker, idempotency, ledger | `packages/core/src/dreams/` | 1.5 |
| **V3b** | Orchestrator and per-session analysis, pattern aggregation with prevalence | `packages/core/src/dreams/learn/` (new) | 2.0 |
| **V3c** | Read-only verify step and contradiction flags | same | 1.0 |
| **V3d** | Proposals with evidence into `memory.proposals`, `memory.curation` and the skill-mining review; web review with evidence and prevalence | `packages/core`, `packages/web` | 1.5 |

**Order.**
- V1 first, in this sequence: V1-E (owner merge), then the pin bump, then V1-H. V1-R runs alongside V1-H.
- V2 after V1.
- V3 after V1 and V2, so accepted findings land with preconditions and sources.
- V3 does not wait for D124; it uses D124 team traces when they exist.
- The D116 tree operations take §3.1.4 into their own work package.

## 5. Tests and gates

**V1**
- Two writers read version n. The first correction wins. The second gets `conflict` with the new head, and the chain has exactly one live head. This is the fork test; it is red on the current Node engine if the analysis in §2 holds.
- `forget`/`share`/`propose` on a superseded id give `conflict`.
- An `expectedVersion` mismatch gives `conflict`.
- An invisible row gives `not-found`, never `conflict` (no oracle).
- Retry once, then hand over to the person.

**V2**
- History of a chain of three versions, including one dream write and one import write, with the correct `actorKind`.
- Revert creates a new head, and the old versions stay.
- Revert from an agent or background origin is refused.
- A viewer without rights sees no foreign versions.

**V3**
- A session the target store's audience may not read never enters the analysis (selection test).
- No `privat` excerpt appears in a proposal shown to another relationship.
- Nothing is applied without acceptance.
- Each proposal carries evidence references and prevalence.
- The breaker and the idempotency key behave as in ADR-009.
- The verify step runs with read-only tools only.

**Gates**
- The engine and RPC contract rules (ADR-016) hold.
- The D125 privacy rule holds: no Jev for transcript content.
- Tests are never skipped or weakened.

## 6. Defaults the owner can still change

- **L1:** `learn` scope is per project. The alternative is per agent.
- **L2:** no automatic application, not even for exact duplicates in the agent's own memory.
- **L3:** the window is 7 days, with at most 50 sessions per run.
