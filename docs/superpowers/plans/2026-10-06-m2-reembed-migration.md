# M2 Re-embedding Migration and Compatibility Probe (Harness side)

**Goal.** M2 acceptance 6 (Harness half): a store whose embedding identity differs from the configured provider is
(1) classified by a **compatibility probe** (`compatible` / `migration-needed` / `incompatible`, with reasons) and
(2) moved to the new identity by a **resumable, throttled re-embedding migration** driven from the CLI,
`plur1bus memory reembed --plan|--run|--status|--abort`, with an **atomic switch** and the **old store kept** until the
owner confirms. Recall keeps answering from the old store during the whole migration.

**Authorities.** `docs/milestones.md` §M2 (scope line "Compatibility probe, … re-embedding migration driven from the
CLI", acceptance 6), ADR-006 §"Embedding identity" (actions 6/7/10), `docs/import.md` §2.3.1/§8.4 (the importer routes
`plannedAction: "re-embedding-migration"` here), ADR-012 (process model), ADR-013 (config restart classes).

## What the engine already gives us (pinned `9bafa04`, contract 1.11.0)

`Engine.admin.reembedding.{plan,apply,resume,status}` (`lib/reembedding/coordinator.js`) own the data path: a
hash-bound plan with a confirmation token, a new quarantined *generation* next to the active one, batches that are
read → embedded with the **target** provider → written → read back and compared, a durable cursor, drift checks on the
source, and a state machine `planned → confirmed → running → validating → ready_to_switch → switching → completed`.
**One batch per `apply`/`resume` call** (`maxBatchesPerOperation = 1`). Gaps that shape this plan:

- `validate` is on the coordinator but **not** on `Engine.admin.reembedding`, and `switch`/`rollback` throw
  "not available" unless the host provides `runtime.config.mutateConfigFile`; the Harness host has `runtime: null`.
  → the Harness must not pretend. The driver talks to a narrow `ReembedEngine` port whose `validate` and `switch` are
  optional capabilities; the real adapter reports what the pinned engine exposes, and the run **fails closed**
  (`engine-validate-unavailable`) instead of switching an unvalidated generation. The engine-side prerequisite is an
  open point (below). The Harness-owned half of a switch (writing the selection into `config.json`) is implemented
  and tested here behind `SwitchPort`.
- Migration is **per installation** (one generation covers every agent's tables), not per agent: no `--agent` flag.

## Design

```
CLI  plur1bus memory reembed --plan|--run|--status|--abort
 └─ RPC  admin.reembed.plan | run | status | abort            (core, experimental, `x-since` 1.5.0; `x-rpc-version` is not bumped: no version bump in this package)
     └─ packages/core/src/embedding-migrate/
          probe.ts     identity comparison → verdict + reasons (pure; uses the engine's own fingerprint id)
          state.ts     <home>/state/reembed/migration.json — checkpoint (atomic tmp+rename, 0600, schema-checked)
          driver.ts    plan / run loop / status / abort over the ReembedEngine port; throttle, fake-clock friendly
          engine-port.ts   ReembedEngine adapter over Engine.admin.reembedding (+ capability detection)
          port.ts      the narrow engine/switch ports (the driver's only dependency on the engine)
          target.ts    --model → the engine's own pinned fingerprint
          switch.ts    SwitchPort over ConfigSource.set (one config.set call = one atomic config.json replace)
          index.ts
```

- **Probe.** Inputs: stored identity (fingerprint of the store, from the engine's inventory/`stores.adopt` evidence)
  and the configured target. Equal engine fingerprint id → `compatible`. Same vector space shape but different
  identity (model/revision/provider/endpoint/prefix/pooling/normalisation/dtype/artefacts differ) →
  `migration-needed`. Anything that cannot be re-embedded safely — dimension unknown, an unpinned/moving revision,
  an unreadable or unverifiable store identity, a target probe that failed — → `incompatible` with the reason.
  Never `compatible` on missing evidence (fail closed).
- **Checkpoint.** The driver persists `{id, token, targetGeneration, phase, counts, cursor, batchSize, throttleMs,
  abortRequested, error}` after every batch. A core restart (or a crash mid-run) resumes from it with the engine's own
  `resume`; the engine's cursor is authoritative for position, ours for orchestration. The token is the plan-bound
  confirmation nonce (not a credential); the file is 0600 and never logged.
- **Throttle.** Between batches the driver waits `throttleMs` (default 250 ms, 0 = none) through an injected
  `sleep`/clock; a `maxRowsPerMinute` ceiling is not added (YAGNI) — batch size (default engine 8) × throttle bounds it.
- **Abort.** `abort` sets `abortRequested` in the checkpoint and fires the run's `AbortSignal`; the loop stops at the
  next batch boundary (never mid-batch, so the engine's readback invariant holds), phase → `aborted`. The target
  generation is left in place and **resumable**: `--run` after an abort continues the same migration id.
- **Switch.** Only from `ready_to_switch` with a validation receipt. `SwitchPort.apply(selection)` performs one
  `config.set` batch writing the target embedding + `engine.reembedding.{activeGeneration,fingerprintId,dimensions}`;
  `engine.*` keys are `x-restart: core`, so the new generation takes effect at the next core start, and **until then
  every recall is answered by the old generation** (the engine never reads the target). No supervisor / file-only
  config → refuse (`switch-unavailable`), nothing written. The old generation is retained; deleting it is a separate
  owner confirmation and is **not** part of this package (open point).
- **Single-flight.** One migration at a time per home (a second `plan` while one is non-terminal answers
  `E_CONFLICT`); `run` holds an in-process guard so two `--run` calls never drive the engine concurrently.

## Files

| Path | New/Changed | Purpose |
|---|---|---|
| `packages/core/src/embedding-migrate/{probe,state,driver,engine-port,switch,index}.ts` | new | the package above |
| `packages/core/test/embedding-migrate/*.test.ts` | new | unit + scenario tests with a fake engine/embedder |
| `packages/core/src/engine-shim.d.ts` | changed (new `declare module` block) | the engine's `fingerprint.js` for the probe |
| `packages/rpc-schema/schema/rpc.schema.json` | changed (new block; `x-rpc-version` stays 1.5.0) | `admin.reembed.*` |
| `packages/core/src/embedding-migrate/rpc.ts`, `core.ts` | new / minimal block | handlers + registration |
| `crates/plur1bus/src/cli.rs`, `commands/memory_reembed.rs` (new), `commands/mod.rs` (one dispatch arm) | changed/new | `memory reembed` |
| `docs/cli.md`, `docs/rpc.md` | generated | `pnpm docs:gen` |
| `docs/embedding-migration.md` | new | operator guide, states, rulings, what is not protected |

## Tasks (each: test first, small commit)

1. **Plan doc** (this file).
2. **Probe** — `probe.ts` + tests: identical → compatible; model/dimension/normalisation/prefix change →
   migration-needed; unknown dimension / moving revision / missing stored identity / failed target probe →
   incompatible; reasons are stable codes.
3. **Checkpoint state** — `state.ts` + tests: round-trip, atomic replace (no partial file on injected crash),
   0600, schema/size validation, unknown phase refused, corrupt file → typed error (never silently reset).
4. **Driver** — `driver.ts` + fake engine (in-memory source rows, deterministic fake embedder, per-batch crash
   injection, source-drift, one-batch-per-call semantics like the real coordinator): plan counts; run to
   `ready_to_switch`; throttle via fake clock; abort mid-run then resume finishes; crash (throw) mid-run then resume
   from checkpoint; recall during run answers from the old store; second plan refused while active.
5. **Switch** — `switch.ts` + tests: one `config.set` carrying all keys; refuses without a supervisor source and
   when not `ready_to_switch`; atomic from the recall side (fake: old store answers before, new after the apply, never
   a mixture); old generation retained.
6. **Engine port** — `engine-port.ts` + tests against a stub shaped like `Engine.admin.reembedding`: argument shapes,
   one-batch semantics, missing `validate`/`switch` → `engine-validate-unavailable`/`switch-unavailable`, engine
   errors mapped to typed codes.
7. **Identity-verified quality** — scenario test: store of N facts, fake embedder A; migrate to fake embedder B;
   recall@k and the ranked id lists for a fixed query set are identical, and every migrated row's vector equals
   `embedB(text)` and its stored fingerprint id is B's (identity verified), none is A's.
8. **RPC** — schema block, handlers (`plan|run|status|abort`; `run` starts a background job and returns the status,
   never blocks past the call), registration in `core.ts`, `packages/webmcp` keeps refusing `admin.*`; RPC tests.
9. **CLI** — `memory reembed` flags and output (`--json` raw value, `schema` ids `memory.reembed.plan/1|run/1|status/1|abort/1`),
   Rust tests against the fake core fixture; `--run` follows status until a terminal phase, Ctrl-C does not abort the job.
10. **Docs** — `docs/embedding-migration.md`; `pnpm docs:gen`; AGENTS.md row.
11. **Gates** — `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm docs:check`, `cargo test --workspace`,
    `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`.

## Acceptance → test

| Acceptance (task text / M2 criterion 6) | Test |
|---|---|
| Probe: compatible / migration needed / incompatible, says why | `test/embedding-migrate/probe.test.ts` |
| Plan shows the correct counts (rows, tables, provider calls, bytes, batches, ETA at the throttle) | `driver.test.ts` "plan counts" |
| Abort in the middle → resume finishes | `driver.test.ts` "abort then resume", "crash then resume from checkpoint" |
| Switch is atomic; recall during migration answers from the old store | `switch.test.ts` + `driver.test.ts` "recall during migration" |
| Identical recall quality with a fake embedder, identity verified | `quality.test.ts` |
| Throttling | `driver.test.ts` "throttle" (fake clock) |
| Old store kept until confirmation | `switch.test.ts` "old generation retained" |
| CLI `plur1bus memory reembed --plan\|--run\|--status\|--abort` | `crates/plur1bus/tests/memory_reembed.rs` |
| Compatibility probe refuses a wrong model and says why (M2 #6) | `probe.test.ts` "refuses", `rpc.test.ts` |

## Rulings (owner questions → recommended default taken, listed in the PR)

- **R1 Scope is per installation**, not per agent (the engine's generation covers all tables).
- **R2 Fail closed on missing evidence**: unknown stored identity or dimension = `incompatible`, never `compatible`.
- **R3 No silent re-embed**: every run needs the plan's confirmation token (the CLI's `--run` takes `--yes` or an
  interactive confirm); a token older than the engine's TTL needs a new `--plan`.
- **R4 Old generation retained**; discarding it is a later explicit confirmation (not built here).
- **R5 Switch takes effect at the next core start** (config class `core`), not by hot-swapping a live engine.
- **R6 Throttle default 250 ms between batches, batch size = engine default (8)**.
- **R7 `--model` is a pinned local-transformers model**: the harness's `engine-config.ts` forces that provider, so a remote target could be copied but never switched to; refused at plan time.
- **R8 The confirmation token lives in the 0600 checkpoint** so `--plan` and `--run` can be separate invocations; `--run` needs `--yes` or an interactive confirm. The plan requests the engine's maximum confirmation lifetime (1 h).
- **R9 `x-rpc-version` is not bumped** (the four methods are experimental, `x-since` 1.5.0); the minor bump belongs to the owner/release.

## Open points (go to the PR)

- **Engine prerequisite:** expose `admin.reembedding.validate` and let a non-OpenClaw host drive `switch`/`rollback`
  (a host-provided selection mutator) in `openclaw-plur1bus-memory`. Until then the real adapter stops at
  `validating` with `engine-validate-unavailable`; everything else is in place and tested with the fake.
- Confirmation/discard of the old generation and the engine's post-switch `completed` recovery.
- A live run against the real local model cache is the nightly's job (`PLUR1BUS_REAL_MODELS`), not CI.
