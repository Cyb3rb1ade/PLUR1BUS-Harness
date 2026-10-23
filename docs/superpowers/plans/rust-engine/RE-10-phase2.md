# RE-10 — Phase 2: memory-facing core paths move into the engine

**Package.** The TypeScript core keeps the front door (RPC entries, RBAC, sessions, tools, channels) and loses the
memory logic it still holds: the journal replay, the restore re-apply, the backup snapshot binding, the re-embedding
driver, the media-search index hook, the dream scheduler's ledger, and the curation handlers. Each path becomes a thin
forward to an `engine.*` method; each path's `node:sqlite` or JSON state moves to the engine's store layer. Size L;
six tasks, one pull request each. Starts after the Phase 1 exit (RE-09 T5 report green).

**Depends on.** Phase 1 complete (RE-01…RE-09). **Enables.** RE-11.

**Assumes.** RE-D1, RE-D9 (the rest of the core stays TypeScript — this brief does not touch sessions, tools, channels,
providers, auth, policy or approvals).

**Read first.**
- Plan §2.3 (Phase 2 row), RE-10 in §4; ADR-009 (the dream scheduler is never a host cron; its *triggers* stay in the
  core, its *ledger and run bodies* may move), ADR-013 §5 (the supervisor owns `config.json`), `docs/dreams.md`,
  `docs/embedding-migration.md`, `docs/media-search.md`, `docs/curation.md`, `docs/rbac.md` (which RPC methods the guard
  secures — unchanged by this brief).
- Core files, each the subject of one task:

| Task | Files | Today | After |
|---|---|---|---|
| T1 | `packages/core/src/replay.ts`, `tests/system/reconnect.test.ts`, `kill-soak.test.ts` | the core journals `memory.capture` calls and replays them after a restart | the engine's turn journal (RE-05) is the one journal; the core forwards `memory.capture` and relies on `engine.capture`'s idempotency key; `replay.ts` shrinks to the status/backlog view (`host.journalBacklog`) |
| T2 | `packages/core/src/restore-reapply.ts`, `backup-ops.ts`, `crates/plur1bus/src/backup/*` (unchanged), `tests/system/{backup,portable-backup}.test.ts` | `admin.backup.snapshot` binds the Node package's snapshot module; re-apply imports a module the pinned engine lacks | both forward to `engine.snapshot.create/verify` and `engine.tombstones.reapply` (RE-07 T5); the KNOWN GAP line in AGENTS.md is removed |
| T3 | `packages/core/src/embedding-migrate/{probe,state,driver,engine-port,switch,rpc}.ts`, `crates/plur1bus/src/commands/memory_reembed.rs` (unchanged), `tests/system/reembed.test.ts` | the core drives the migration and keeps the checkpoint | `admin.reembed.*` forward to `engine.admin.reembedding.*` (RE-07 T6); the checkpoint lives in the engine's state file; `--json` shapes unchanged (ruling R13) |
| T4 | `packages/core/src/media-search/*` (the index hook and backfill job), `docs/media-search.md` | the core calls the engine's vector search around its caption pipeline | the index hook becomes `engine.media.index` (a new `x-server: "engine"` method with `x-since`); the caption pipeline and ffmpeg ports stay in the core |
| T5 | `packages/core/src/dreams/{scheduler,store,candidates,producer,methods}.ts`, `tests/system/dreams.test.ts` | the scheduler evaluates cron/importance triggers and keeps `dream_run`/`dream_schedule`/`dream_candidate` in `node:sqlite` | the scheduler keeps evaluating triggers in the core and calls `engine.jobs.run` (already so); the ledger and candidate gates move to the engine (`engine.dreams.{status,log,schedule,diary}`); `plur1bus dreams …` output unchanged |
| T6 | the `memory.curation.*` handlers in `packages/core/src`, `packages/web` curation tab (unchanged), `crates/plur1bus/src/commands/memory_ops.rs` (unchanged) | handlers wait for engine 1.17.0 | handlers forward to `engine.memory.curation.*` (RE-07 T1) |

**Rules that apply.** The core stays the policy front door: every moved method keeps its `x-server: "core"` entry,
its RBAC rule and its capability listing; it forwards after the guard. No CLI or API client connects to the engine
endpoint. Every new `engine.*` method goes through the schema with `x-since`. A move is one PR per path, with the
path's tests re-pointed and the path's store file removed in the same PR; `--json` shapes do not change.

## Files

Per task: the core files in the table; `packages/rpc-schema/schema/rpc.schema.json` (new `engine.*` methods for T4
and T5), `crates/plur1bus-engine/src/{ops,jobs}` additions (`media.index`, `dreams.*`), `docs/dreams.md`,
`docs/embedding-migration.md`, `docs/media-search.md`, `docs/curation.md`, AGENTS.md (the `packages/core` row loses the
moved parts; the KNOWN GAP line goes), `docs/architecture.md`.

## Interfaces

**Consumes:** RE-08 `EngineClient`, the `engine.*` surface, RE-07's ops, RE-05's journal, RE-06's dreams bodies.

**Produces:** `engine.media.index { … }` and `engine.dreams.{status,log,schedule,diary}` in the schema (shapes copied
from today's `dreams.*` results so the CLI output stays byte-identical); the core's forwarding handlers
(`forwardToEngine(method, params, ctx)` helper in `packages/core/src/engine/forward.ts`, which applies the RBAC guard
first and maps transport failures to `E_NOT_AVAILABLE reason=engine-unavailable`).

## Tasks

Each task has the same five steps; the table above names the files.

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

## Acceptance

- After T6: `grep -rn "node:sqlite" packages/core/src` lists no memory-owned store (sessions, approvals, identity,
  budget, collab, licences and the toolcall registry remain — they are not memory).
- `tests/system/*` green with `PLUR1BUS_ENGINE_IMPL=rust`, including `dreams`, `reembed`, `backup`, `portable-backup`,
  `reconnect`, `kill-soak`.
- The CLI `--json` goldens of step 1 unchanged for every path.

## Out of scope

Everything RE-D9 names (the rest of the core); changing which methods RBAC secures; the default flip (RE-11).

## Hand-off

Six PRs, any order after Phase 1 exit; T2 and T6 are the smallest and make good first tasks. Each PR carries the
parity golden it pinned and the system test it ran.
