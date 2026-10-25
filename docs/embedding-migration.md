# Embedding compatibility probe and re-embedding migration (M2 acceptance 6)

`plur1bus memory reembed` moves the store to a new embedding model **without a mixed vector space and without a silent
re-embed**. The Harness drives the engine's own re-embedding coordinator (`Engine.admin.reembedding`); the engine owns
the data path, the Harness owns the orchestration. Design and decisions: `docs/superpowers/plans/2026-10-06-m2-reembed-migration.md`,
ADR-006 §"Embedding identity", `docs/import.md` §2.3.1 (the importer routes a store with a different identity here).

> Status: experimental (`memory reembed`, `admin.reembed.*`). Read "What is not done" before relying on it.

## The compatibility probe

The verdict compares the store's embedding identity with the target, using the engine's own fingerprint (provider, model,
pinned revision, dimensions, endpoint, query/passage prefix, pooling, normalisation, dtype, artefact hashes):

| Verdict | Meaning | `reasons` (stable codes) |
|---|---|---|
| `compatible` | same identity; nothing to migrate | – |
| `migration-needed` | the vectors must be re-embedded before the new model can be used | `provider-changed`, `model-changed`, `revision-changed`, `dimension-changed`, `endpoint-changed`, `query-prefix-changed`, `passage-prefix-changed`, `pooling-changed`, `normalisation-changed`, `dtype-changed`, `artifacts-changed` |
| `incompatible` | refused; says why | `stored-identity-missing`, `stored-identity-invalid`, `target-identity-invalid`, `target-revision-unpinned`, `target-model-unpinned`, `target-provider-unusable` |

Missing evidence is never `compatible` (fail closed). The probe never contains a credential or a store path.

## Default model and existing stores

The unified local default is EmbeddingGemma 2 (text-only, 768 dimensions, Apache-2.0; ADR-006 amendment 2026-10-08), which the pinned engine pins as `google/embeddinggemma-2` (ONNX export `onnx-community/embeddinggemma-2-ONNX` @ `daa72c51…`, q8). The first-run wizard preselects it and writes it into `engine.embedding` while the store holds no table (its Memory step comes before the first agent is created; `docs/web-ui.md` F35). Without an `engine.embedding` model, `engine-config.ts` keeps running `intfloat/multilingual-e5-small` (384), so a store built on that implicit default keeps its vector space. Existing stores keep their recorded identity: nothing is re-embedded implicitly, and a store created with `intfloat/multilingual-e5-small` (384) or any other model stays valid. To move it, run `plur1bus memory reembed --plan` first (below).

A store holds a table as soon as an agent exists (creating an agent creates its table) or a generation was copied, even an empty one: the engine binds every table to the vector space it was created in and refuses it under another model. So the Harness API runs `model.licence.check` before every web `config.set`, and that check refuses a change of the engine's embedding identity (derived with the engine's own normalisation and fingerprint) while the store holds a `*.lance` table, or uses a named namespace layout: `E_CONFLICT` reason `embedding-migration-required`, nothing written (`packages/core/src/embedding-migrate/selection.ts`). A local model the engine does not pin is refused there too (`E_INVALID_PARAMS` reason `embedding-model-unavailable`). `model.memory.status` tells a client the models the running engine was built with and whether the embedding can still change (`embeddingSwitch`). The same check refuses a configuration that takes a pinned non-commercial embedding's licence acceptance away (the commercial use class, a withdrawn `embedding.acceptedNcLicence`): the engine loads such a model only with `modelPreparation.acceptNonCommercialLicense`, which `buildEngineConfig` gives only then. While the store holds data embedded with that model the refusal is `embedding-migration-required`, otherwise `embedding-model-unavailable`.

### From `plur1bus config set`

`plur1bus config set` goes to the supervisor, which does not run the web pre-check. So the CLI asks the core first whenever the change touches `engine`, `engine.embedding*`, `engine.reranker*`, `engine.modelPreparation*` or `embedding.*` (`crates/plur1bus/src/commands/config_embedding.rs`): `admin.embedding.check` (CLI-only like every `admin.*` method) answers `effect` `unchanged` (the running vector space), `write` (another embedding over a store without data, or under an engine without a usable embedding) or `move` (another embedding over a store with data), plus `target`, the spec `admin.reembed.plan` takes, and `canSwitch` (whether the engine exposes `validate`; true with the pinned engine, contract 1.17.0). It refuses what the engine could not load, with the reasons above, and a non-commercial memory model without a persisted licence confirmation (`E_DENIED` `model-licence-required`, the start-time gate `checkEngineConfigLicences`). A `target` must reproduce the block's own fingerprint through the plan's spec (provider, model, dimensions, local prefixes, endpoint, key variable); a block a plan cannot describe is `embedding-model-unavailable`.

`unchanged` and `write` are written by `config.set` as before. A `move` is not written: the CLI plans (`--dry-run` stops there and prints `memory.reembed.plan/1`), asks (`--yes`), and starts `admin.reembed.run { switch: true }`; it follows the run in the foreground (Ctrl-C only stops the following) or, with `--background`, prints the start's checkpoint and returns, and the core switches by itself after the copy. Either way the output is `memory.reembed.run/1`, and the switch writes the embedding. A move writes only the embedding: a change that sets other keys beside it (`config set engine '{…}'`) is refused with `E_INVALID_PARAMS` `move-with-other-changes` and the keys it names, so nothing is dropped silently; set them in a separate `config set`. With `canSwitch` false (an engine before contract 1.17.0) the CLI says before the copy that the run stops before the switch. Without a core (or a core older than the check) nothing can be checked: the change is written and a warning on stderr says so, because a configuration the core cannot start with must stay fixable from the CLI.

## Commands

```bash
plur1bus memory reembed --plan --model intfloat/multilingual-e5-small [--dimensions N] [--throttle-ms 250]
# e.g. the unified local default of ADR-006 (amendment 2026-10-08), under the engine's own model id:
plur1bus memory reembed --plan --model google/embeddinggemma-2 --dimensions 768
# a cloud or self-hosted target (owner decision 2026-10-18: every direction, local and cloud alike):
plur1bus memory reembed --plan --provider openrouter --model qwen/qwen3-embedding-8b --dimensions 4096 \
  --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY [--acknowledge-privacy]
plur1bus memory reembed --run [--yes] [--no-switch] [--no-wait]
plur1bus memory reembed --status
plur1bus memory reembed --abort
# the same migration from a configuration change (above): foreground, or --background, or --dry-run for the plan alone
plur1bus config set engine.embedding.local.model google/embeddinggemma-2 [--yes] [--background] [--dry-run]
```

- The migration is **per installation**: the engine copies every agent's tables into one new generation. There is no `--agent`.
- **Every direction migrates**: local → cloud, cloud → local, cloud → cloud (another provider, model or dimension count) and
  local → local. Owner, 18.10.2026: "das System soll in alle Richtungen migrationsfähig sein, sonst schränken wir den User zu
  sehr ein". Without `--provider` (or with `local-transformers`) `--model` is a pinned local model. Any other provider goes
  through the same rules as the engine start (`composition/embedding-policy.ts`): `--model`, `--dimensions` and
  `--api-key-env` (the variable's **name**; the key never travels) are required, `--base-url` except for `openai`; a
  non-loopback endpoint needs a privacy acknowledgment (`memory.embedding.privacyAck` for exactly that provider and endpoint,
  or `--acknowledge-privacy`, see below; `E_DENIED` `privacy-acknowledgment-required`); `privacy.localOnly` refuses a cloud
  target (`E_DENIED` `local-only`); the endpoint must pass the egress policy (`E_DENIED` `egress-denied`). Nothing else
  refuses a direction. The target fingerprint is built with the engine's own functions, so the id equals what the engine
  derives at start.
- `--acknowledge-privacy` records the calling person's acknowledgment of the cloud target at plan time (bound to provider and
  endpoint, kept in the checkpoint). It is what makes cloud → cloud possible while `memory.embedding.privacyAck` still admits
  the provider in use: the switch writes it as `memory.embedding.privacyAck` in the same `config.set` as the new block.
- For a cloud target `--plan` also shows that **every card text goes to the provider**, the number of cards, the estimated
  tokens (an upper bound from the source size without its vectors, bytes / 4); there is no cost estimate (no money
  dimension since 2026-10-19). The engine's plan probes the provider with one short text.
- `--plan` copies nothing. It prints the verdict and the counts: rows, tables, batches, provider calls, source and target
  bytes, free space needed and available, the pause between batches and the minimum time those pauses add up to. Exit 1 for
  `incompatible`.
- `--run` asks for confirmation (`--yes` outside a terminal), starts the migration **inside the core** and follows it
  (progress on stderr, one final document with `--json`). Ctrl-C stops the following, not the migration. `--no-wait` returns
  after the start. `--no-switch` copies and validates but does not switch.
- For a cloud target `--run` asks with the provider named. Before every batch the estimated tokens are reserved in the call
  budget (principal, agent and project `memory-reembed`); a hard token limit
  pauses the run: phase `aborted`, error `budget-exceeded` in `--status`, continued with `--run` once the budget allows it.
  A rate limit or a transient provider error (429, 5xx, network) is retried with exponential backoff (1 s, 2 s, 4 s, 8 s,
  at most 30 s) before the run halts (`aborted`, resumable). Before a run starts the rules are checked again
  (`privacy.localOnly`, acknowledgment, egress may have changed since the plan).
- `--abort` stops at the next batch boundary (never mid-batch). The copied generation stays; `--run` continues the same
  migration. A halted run (engine error, core stop) is `aborted` with the error in the checkpoint and is resumed the same way.
- JSON schema ids: `memory.reembed.plan/1`, `memory.reembed.run/1`, `memory.reembed.status/1`, `memory.reembed.abort/1`
  (each is the raw core value; `run` is the final `status` value when it followed, or `{ checkpoint }` with `--no-wait`).

## Phases

`planned → running → validating → ready-to-switch → switched`, plus `aborted` (stopped, resumable) and `failed` (final: source
drift, an invalid or expired confirmation; plan again). In `validating` the engine (`admin.reembedding.validate`, contract
1.17.0) checks the source versions and the target generation and recalls one source memory from the copy with the target
model; an agent table without memories is validated on the generation check alone. A failed validation stops the run in
`validating` (or `aborted`/`failed`, classified like any engine error) with the engine's reason, and the old model stays active.
`validating` with the error `engine-validate-unavailable` only appears with an engine before 1.17.0. The checkpoint is `<home>/state/reembed/migration.json` (atomic replace, 0600, validated;
a corrupt file is refused and left in place, never reset). It holds the engine's plan-bound confirmation token (not a
credential); the token is never returned over RPC or printed.

### Planning again

The engine keeps a plan that was never confirmed (no `--run` yet) for its confirmation lifetime, one hour, and refuses
every other plan meanwhile (its state store, `reembedding_active_conflict`); it has no call to retire one earlier. So the
driver never replaces a live, unstarted plan (`planned`, or `aborted` before its first batch):

- **The same target again** (the same engine fingerprint id, key variable, endpoint and target generation), as a dry run
  followed by the apply does, is answered from the stored plan: the same id and figures, no second engine plan. Only the
  Harness settings change (`--throttle-ms`, a fresh `--acknowledge-privacy`), and an aborted unstarted plan is `planned`
  again. The checkpoint keeps the plan answer and the engine's confirmation expiry for this (`plan`, `expiresAt`; neither
  is part of the RPC checkpoint).
- **Another target** is `E_CONFLICT` `migration-active`, naming the plan's model and the time it expires. `--run` starts the
  planned one; `--abort` does not release it earlier.
- **After the expiry** the next plan replaces it; the engine retires the expired record itself (`failed`,
  `expired_migration_superseded`).

## The switch

Only from `ready-to-switch` (copied, read back, validated). One `config.set` on the supervisor writes the target embedding
block (a local one as the pinned local block; a remote one as `provider`, `model`, `dimensions`, `baseUrl` and the key only as
`apiKeyEnv`, no fallback), a plan-time acknowledgment if there is one, and
`engine.reembedding = { activeGeneration, fingerprintId, dimensions }` together (all keys or none, one atomic
`config.json` replace). Those keys are class `core`, so the supervisor restarts the core and the new generation is active
from that start. **Until the config is replaced every recall is answered by the old generation**; the copy never touches it.
Before writing, the guard derives the fingerprint the engine will derive from the written configuration (the functions
`create-engine.js` calls at start) and refuses on any difference, because a mismatch would make the core refuse to start. No
supervisor (config is just the file) → `switch-unavailable`, nothing written. The **old generation is kept** on disk.

## Guards

- **One operation at a time.** A plan or a switch in flight refuses a second plan, a start, a switch and an abort; a run in
  flight refuses a plan. A switch is never aborted half-way.
- **The engine's answer must match the checkpoint.** A plan whose target provider, model or dimensions differ from the
  requested one is refused (`plan-refused`, no checkpoint). A switch is refused (`not-ready-to-switch`) when the engine's
  finished target differs from the planned one, so a different vector space is never written to the configuration.
- **No progress, no loop.** A batch that leaves the engine's cursor where it was halts the run (`aborted`, error
  `engine-error`, "no progress"); it can be resumed.
- **Progress.** `percent` is capped at 100; `batchesDone` is raised to what the engine's cursor shows, so it stays right after a
  restart that lost the last checkpoint write.

## Throttling

A pause of `--throttle-ms` (default 250) after every batch but the last; the engine's batch is 8 rows. Batch size × pause
bounds the load on the provider and the machine.

## Errors (RPC `admin.reembed.*`)

| Error / reason | When |
|---|---|
| `E_CONFLICT` `migration-active` | `plan` while an earlier migration has started and is unfinished; `plan` of another target while an unstarted plan has not expired (the same target reuses it, "Planning again"); `plan` while the engine still holds a record no live checkpoint describes, for example a run that failed with source drift (until its confirmation expires) |
| `E_CONFLICT` `migration-running` / `not-runnable` / `not-abortable` / `not-ready-to-switch` | the call does not fit the phase |
| `E_CONFLICT` `migration-active` / `migration-running` / `not-abortable` | a plan or a switch is in flight and another plan, start, switch or abort arrives (one at a time per core); a plan during a run is `migration-running` |
| `E_CONFLICT` `not-ready-to-switch` | also when the engine's finished target (generation, provider, model, dimensions) differs from the planned one; nothing is written |
| `E_NOT_FOUND` `no-migration` | `run`/`abort` without a plan |
| `E_INVALID_PARAMS` `plan-refused` | the engine refused the plan (e.g. not enough free disk) |
| `E_NOT_AVAILABLE` `switch-unavailable` | no supervisor, a target the engine start would refuse (missing acknowledgment, `privacy.localOnly`, missing details), or a fingerprint the engine would not derive; nothing is written and the old configuration stays active |
| `E_DENIED` `privacy-acknowledgment-required` / `local-only` / `egress-denied` | `plan` or `run` of a cloud target the provider rules refuse; the engine is not asked |
| `E_INVALID_PARAMS` `engine-provider-config-incomplete` | a cloud target without model, dimensions, apiKeyEnv or (except openai) baseUrl |
| `E_STORAGE` `switch-failed` / `state-corrupt` / `state-unreadable` | the config write failed / the checkpoint is unusable / the checkpoint cannot be read or written (the message names no path) |

## What is not done (open points)

- **Done (2026-10-25): end to end.** The pinned engine (contract 1.17.0) exposes `validate`, so a run reaches
  `ready-to-switch` and the Harness switch (`docs/superpowers/plans/2026-10-25-reembed-validate.md`). Tested against the real
  engine in-process (`packages/core/test/embedding-migrate/core-stack.test.ts`) and through the supervisor
  (`tests/system/reembed.test.ts`: `plur1bus config set engine.embedding.local.model google/embeddinggemma-2 --yes` on a store
  with data reaches `switched`, foreground and `--background`, the core restarts on the new generation and recall answers).
- **Engine prerequisite, still open:** the engine's own `switch`/`rollback` need a host config-mutation capability this host
  does not have (the Harness owns its switch), and the engine's post-switch `completed` transition and rollback are engine
  work; the engine record stays `ready_to_switch` after the Harness switch.
- **Confirming the switch / discarding the old generation** is a later explicit step, not part of this package.
- **A plan holds the engine for up to an hour.** An unstarted plan for one target blocks a plan for another until its
  confirmation expires ("Planning again"); the same target reuses it. A run that fails with source drift (the store changed
  after the plan) leaves its engine record `running`, which likewise blocks the next plan until that expiry. Retiring a
  record earlier needs an engine call the pinned contract does not have (a coordinator `discard` on
  `admin.reembedding`).
- A live run with real models belongs to the nightly (`PLUR1BUS_REAL_MODELS`), not to CI.
- **Cloud targets:** the engine reports no token usage per batch, so the budget is settled with the estimate. The keys
  reach the engine only as `apiKeyEnv` (the engine has no harness secret-store port yet). The engine's own provider calls
  are judged by egress at plan and run time (`decide`), not per request: that needs the engine fetch port.
