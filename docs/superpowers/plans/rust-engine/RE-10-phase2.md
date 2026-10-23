# RE-10 — Phase 2: memory-facing core paths move into the engine

**Package.** The TypeScript core keeps the front door (RPC entries, RBAC, sessions, tools, channels) and loses the
memory logic it still holds: the journal replay, the restore re-apply, the backup snapshot binding, the re-embedding
driver, the media-search index hook, the dream scheduler's ledger, and the curation handlers. Each path becomes a thin
forward to an `engine.*` method; each path's `node:sqlite` or JSON state moves to the engine's store layer. Size L;
nine tasks, one pull request each: six moves (T1–T6) and three behaviour changes (T7–T9) that Phase 1 kept at parity
on purpose (plan §1.6), each behind an owner decision. Starts after the Phase 1 exit (RE-09 T5 report green).

**Depends on.** Phase 1 complete (RE-01…RE-09). **Enables.** RE-11.

**Assumes.** RE-D1, RE-D9 (the rest of the core stays TypeScript — this brief does not touch sessions, tools, channels,
providers, auth, policy or approvals). For T7–T9: RE-D11, RE-D12 and RE-D13 as recorded in plan §6; a task whose
decision is still open does not start.

**Read first.**
- Plan §2.3 (Phase 2 row), RE-10 in §4; ADR-009 (the dream scheduler is never a host cron; its *triggers* stay in the
  core, its *ledger and run bodies* may move), ADR-013 §5 (the supervisor owns `config.json`), `docs/dreams.md`,
  `docs/embedding-migration.md`, `docs/media-search.md`, `docs/curation.md`, `docs/rbac.md` (which RPC methods the guard
  secures — unchanged by this brief).
- For T7–T9: plan §1.6 (the three behaviours, their evidence and the fix behind each decision), `docs/host-contract.md`
  (d.3), `docs/engine-extraction.md` R5, the engine's `KNOWN-ISSUES.md` ("Recall observations" and the last "Deferred
  findings" item), RE-02 T2 (the metric pin), RE-04 T2/T3 (the stages T7 and T8 change), RE-06 T3/T5/T6 (the partition
  routing T9 changes).
- Core files, each the subject of one task:

| Task | Files | Today | After |
|---|---|---|---|
| T1 | `packages/core/src/replay.ts`, `tests/system/reconnect.test.ts`, `kill-soak.test.ts` | the core journals `memory.capture` calls and replays them after a restart | the engine's turn journal (RE-05) is the one journal; the core forwards `memory.capture` and relies on `engine.capture`'s idempotency key; `replay.ts` shrinks to the status/backlog view (`host.journalBacklog`) |
| T2 | `packages/core/src/restore-reapply.ts`, `backup-ops.ts`, `crates/plur1bus/src/backup/*` (unchanged), `tests/system/{backup,portable-backup}.test.ts` | `admin.backup.snapshot` binds the Node package's snapshot module; re-apply imports a module the pinned engine lacks | both forward to `engine.snapshot.create/verify` and `engine.tombstones.reapply` (RE-07 T5); the KNOWN GAP line in AGENTS.md is removed |
| T3 | `packages/core/src/embedding-migrate/{probe,state,driver,engine-port,switch,rpc}.ts`, `crates/plur1bus/src/commands/memory_reembed.rs` (unchanged), `tests/system/reembed.test.ts` | the core drives the migration and keeps the checkpoint | `admin.reembed.*` forward to `engine.admin.reembedding.*` (RE-07 T6); the checkpoint lives in the engine's state file; `--json` shapes unchanged (ruling R13) |
| T4 | `packages/core/src/media-search/*` (the index hook and backfill job), `docs/media-search.md` | the core calls the engine's vector search around its caption pipeline | the index hook becomes `engine.media.index` (a new `x-server: "engine"` method with `x-since`); the caption pipeline and ffmpeg ports stay in the core |
| T5 | `packages/core/src/dreams/{scheduler,store,candidates,producer,methods}.ts`, `tests/system/dreams.test.ts` | the scheduler evaluates cron/importance triggers and keeps `dream_run`/`dream_schedule`/`dream_candidate` in `node:sqlite` | the scheduler keeps evaluating triggers in the core and calls `engine.jobs.run` (already so); the ledger and candidate gates move to the engine (`engine.dreams.{status,log,schedule,diary}`); `plur1bus dreams …` output unchanged |
| T6 | the `memory.curation.*` handlers in `packages/core/src`, `packages/web` curation tab (unchanged), `crates/plur1bus/src/commands/memory_ops.rs` (unchanged) | handlers wait for engine 1.17.0 | handlers forward to `engine.memory.curation.*` (RE-07 T1) |

- Behaviour changes, each the subject of one task once its decision is recorded (plan §1.6):

| Task | Decision | Today | After |
|---|---|---|---|
| T7 | RE-D11 | `score = 1/(1+d)` over the squared-L2 `_distance` (floor 0.2 for unit vectors); `minScore` 0.3 inert; `forgetThreshold` without a consumer; query refinement practically off; additive boosters on that scale (`lib/score.js:15`, `lib/recall-pipeline.js:990`, `:1723`, `:1936-1950`) | `score` is the cosine similarity (`1 − d/2`); `minScore` per embedding profile from a golden set; boosters re-weighted; `forgetThreshold` consumed by `MemoryOps.forget` by text or removed from the schema; refinement re-gated or removed; an A/B on a frozen corpus in the PR |
| T8 | RE-D12 | vector search, graph spread and the neo prelude are the only candidate sources; no exact-id or lexical path | exact id and metadata lookup, a Lance full-text index over `text` and `summary`, and the vector search feed one pool; reciprocal rank fusion before the ACL, budget, rerank and dedupe stages; the same fusion merges the candidates of two embedding identities |
| T9 | RE-D13 | the `workspace`/`user` partitions of `rem-dream`, `consolidate-daily` and `skill-miner` read the shared pools only; a scoped row in the agent table belongs to no partition | the agent partition reads every row of the agent table the job's principal may read; the shared pools stay separate partitions; no row moves; the routing security test re-derived in Rust |

**Rules that apply.** The core stays the policy front door: every moved method keeps its `x-server: "core"` entry,
its RBAC rule and its capability listing; it forwards after the guard. No CLI or API client connects to the engine
endpoint. Every new `engine.*` method goes through the schema with `x-since`. A move is one PR per path, with the
path's tests re-pointed and the path's store file removed in the same PR; `--json` shapes do not change.

## Files

Per task: the core files in the table; `packages/rpc-schema/schema/rpc.schema.json` (new `engine.*` methods for T4
and T5), `crates/plur1bus-engine/src/{ops,jobs}` additions (`media.index`, `dreams.*`), `docs/dreams.md`,
`docs/embedding-migration.md`, `docs/media-search.md`, `docs/curation.md`, AGENTS.md (the `packages/core` row loses the
moved parts; the KNOWN GAP line goes), `docs/architecture.md`.

T7–T9: `crates/plur1bus-engine/src/recall/{score,sources,fusion}.rs`, `src/store/text_index.rs` (T8, through RE-02's
`Store`), `src/jobs/partition.rs` (T9), the goldens the change touches under `tests/engine-parity/golden/`,
`tests/engine-parity/corpus/recall-ab/` (T7), `docs/engine-stores.md` (the index), `docs/dreams.md` (the partitions).

## Interfaces

**Consumes:** RE-08 `EngineClient`, the `engine.*` surface, RE-07's ops, RE-05's journal, RE-06's dreams bodies.

**Produces:** `engine.media.index { … }` and `engine.dreams.{status,log,schedule,diary}` in the schema (shapes copied
from today's `dreams.*` results so the CLI output stays byte-identical); the core's forwarding handlers
(`forwardToEngine(method, params, ctx)` helper in `packages/core/src/engine/forward.ts`, which applies the RBAC guard
first and maps transport failures to `E_NOT_AVAILABLE reason=engine-unavailable`).

T7–T9 produce: `recall::score::cosine(distance: f32) -> f32` and the threshold table per embedding profile (T7);
`Store::ensure_text_index(&self) -> Result<(), StoreError>` on RE-02's trait and
`recall::fusion::rrf(sources: &[RankedSource]) -> Vec<Candidate>` (T8; the trait change needs the controller's
agreement, RE-02's hand-off rule); `jobs::partition::agent_rows(principal: &Principal) -> RowFilter` (T9).

## Tasks

T1–T6 share the same five steps; the first table names the files. T7–T9 have their own steps below.

- [ ] **Step 1: pin today's behaviour** — the path's existing tests pass on `main`; add a golden of its `--json` output
  (CLI) or RPC result to `tests/engine-parity/golden/phase2/<task>.json` through the parity runner's `--record`.
- [ ] **Step 2: write the failing test** that the core handler forwards: a fake engine RPC server records the call;
  the core's RBAC guard still refuses a principal without the role (negative test); the transport failure maps to
  `E_NOT_AVAILABLE`.
- [ ] **Step 3: implement** the engine side (where the table says so) and the forward; delete the core's store file for
  the path (`node:sqlite` ledger, JSON state) and the code that wrote it; migrate existing state once at core start
  (T5: import the `dream_*` rows into the engine's ledger on first start, idempotent, logged).
- [ ] **Step 4: verify** — the path's system test with `PLUR1BUS_ENGINE_IMPL=rust`; the parity golden of step 1 still
  matches; `pnpm docs:gen` for the schema change; `pnpm docs:check`.
- [ ] **Step 5: commit** `RE-10/T<n>: <path> moves into the engine`.

### T7–T9 — behaviour changes (one pull request each, after the decision)

The three behaviours plan §1.6 names; Phase 1 ported them as they are and the goldens encode them.

- [ ] **Step 0: the decision is recorded** — the plan's §6 row carries the owner's answer and its date and the README
      status table names the task; without it the task does not start (RE-R1).
- [ ] **Step 1: pin today's behaviour** — the RE-09 scenarios the change touches are green on the current head. T7 also
      records a frozen corpus, `tests/engine-parity/corpus/recall-ab/` (from the Node engine: the flat embedder plus one
      real-model run), with today's ordered ids per query.
- [ ] **Step 2: failing tests** — T7 `tests/recall_score.rs`: `score_is_the_cosine_similarity_of_unit_vectors`,
      `min_score_filters_at_the_calibrated_value_of_the_profile`, `boosters_keep_their_relative_weight_on_the_new_scale`;
      T8 `tests/recall_sources.rs`: `an_exact_id_query_finds_the_row_without_a_vector_hit`, `a_rare_token_is_found_lexically`,
      `rank_fusion_preserves_each_source_order`, `two_identities_fuse_by_rank_not_by_score`,
      `the_acl_runs_on_the_fused_pool_before_any_provider`; T9 `tests/jobs_partitions.rs`:
      `the_agent_partition_reads_its_own_workspace_scoped_rows`, `the_shared_pool_partition_is_unchanged`,
      `a_row_of_another_agent_is_never_read` (the routing security property the engine's
      `tests/release-731-runtime-callsite-security.test.js` pins today).
- [ ] **Step 3: implement.** T7: `recall::score::cosine`, the threshold table per embedding profile, the re-weighted
      boosters, `forgetThreshold` consumed or removed (schema change through RE-01's generator). T8: the index through
      `Store::ensure_text_index` only (nothing outside the store layer writes it; built once over existing rows at first
      use, maintained on write), the exact and lexical sources, `fusion::rrf`, wired before the ACL stage. T9: the agent
      partition's `RowFilter` and the unchanged pool partitions.
- [ ] **Step 4: re-record** the touched goldens with the parity runner's `--record`; the decision id is in the commit
      body. T7's PR quotes the A/B against the frozen corpus (ids moved per query, with the reason) and the thresholds
      per profile.
- [ ] **Step 5: verify** — `tests/system/two-session-recall.test.ts` (T7, T8) and `dreams.test.ts` (T9) with
      `PLUR1BUS_ENGINE_IMPL=rust`; RE-02's Node round trip against a store that carries T8's index; recall budgets
      still met with the extra sources (RE-04 T6's numbers re-quoted).
- [ ] **Step 6: commit** `RE-10/T7: cosine score and calibrated thresholds (RE-D11)`, `RE-10/T8: hybrid retrieval with
      rank fusion (RE-D12)`, `RE-10/T9: the agent partition reads its scoped rows (RE-D13)`.

## Acceptance

- After T6: `grep -rn "node:sqlite" packages/core/src` lists no memory-owned store (sessions, approvals, identity,
  budget, collab, licences and the toolcall registry remain — they are not memory).
- `tests/system/*` green with `PLUR1BUS_ENGINE_IMPL=rust`, including `dreams`, `reembed`, `backup`, `portable-backup`,
  `reconnect`, `kill-soak`.
- The CLI `--json` goldens of step 1 unchanged for every path.
- T7–T9, each after its decision: the re-recorded goldens carry the decision id; T7's PR quotes the A/B and the
  calibrated thresholds per profile; a store that carries T8's index still opens in the Node reader (RE-02's round
  trip); T9's routing security test is green in Rust.

## Out of scope

Everything RE-D9 names (the rest of the core); changing which methods RBAC secures; the default flip (RE-11); a change
of embedding model or any re-embedding (none of T7–T9 needs one); a different vector metric (plan §1.6: it would change
numbers, never ranks).

## Hand-off

Nine PRs. T1–T6 in any order after Phase 1 exit; T2 and T6 are the smallest and make good first tasks. T7–T9 start
only once their decision is recorded (step 0) and can run in parallel with the moves. Each PR carries the parity golden
it pinned or re-recorded and the system test it ran.
