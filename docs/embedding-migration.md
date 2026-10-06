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

## Commands

```bash
plur1bus memory reembed --plan --model intfloat/multilingual-e5-small [--dimensions N] [--throttle-ms 250]
plur1bus memory reembed --run [--yes] [--no-switch] [--no-wait]
plur1bus memory reembed --status
plur1bus memory reembed --abort
```

- The migration is **per installation**: the engine copies every agent's tables into one new generation. There is no `--agent`.
- `--model` is a **pinned local embedding model** (the Harness runs the engine with local-transformers embeddings; a remote
  provider could be copied into but never switched to, so it is refused at plan time). The target fingerprint is built with
  the engine's own functions, so the id equals what the engine derives at start.
- `--plan` copies nothing. It prints the verdict and the counts: rows, tables, batches, provider calls, source and target
  bytes, free space needed and available, the pause between batches and the minimum time those pauses add up to. Exit 1 for
  `incompatible`.
- `--run` asks for confirmation (`--yes` outside a terminal), starts the migration **inside the core** and follows it
  (progress on stderr, one final document with `--json`). Ctrl-C stops the following, not the migration. `--no-wait` returns
  after the start. `--no-switch` copies and validates but does not switch.
- `--abort` stops at the next batch boundary (never mid-batch). The copied generation stays; `--run` continues the same
  migration. A halted run (engine error, core stop) is `aborted` with the error in the checkpoint and is resumed the same way.
- JSON schema ids: `memory.reembed.plan/1`, `memory.reembed.run/1`, `memory.reembed.status/1`, `memory.reembed.abort/1`
  (each is the raw core value; `run` is the final `status` value when it followed, or `{ checkpoint }` with `--no-wait`).

## Phases

`planned → running → validating → ready-to-switch → switched`, plus `aborted` (stopped, resumable) and `failed` (final: source
drift, an invalid or expired confirmation; plan again). `validating` with the error `engine-validate-unavailable` waits for an
engine that can validate (see below). The checkpoint is `<home>/state/reembed/migration.json` (atomic replace, 0600, validated;
a corrupt file is refused and left in place, never reset). It holds the engine's plan-bound confirmation token (not a
credential); the token is never returned over RPC or printed.

## The switch

Only from `ready-to-switch` (copied, read back, validated). One `config.set` on the supervisor writes the target embedding
block and `engine.reembedding = { activeGeneration, fingerprintId, dimensions }` together (all keys or none, one atomic
`config.json` replace). Those keys are class `core`, so the supervisor restarts the core and the new generation is active
from that start. **Until the config is replaced every recall is answered by the old generation**; the copy never touches it.
Before writing, the guard derives the fingerprint the engine will derive from the written configuration (the functions
`create-engine.js` calls at start) and refuses on any difference, because a mismatch would make the core refuse to start. No
supervisor (config is just the file) → `switch-unavailable`, nothing written. The **old generation is kept** on disk.

## Throttling

A pause of `--throttle-ms` (default 250) after every batch but the last; the engine's batch is 8 rows. Batch size × pause
bounds the load on the provider and the machine.

## Errors (RPC `admin.reembed.*`)

| Error / reason | When |
|---|---|
| `E_CONFLICT` `migration-active` | `plan` while an earlier migration is unfinished |
| `E_CONFLICT` `migration-running` / `not-runnable` / `not-abortable` / `not-ready-to-switch` | the call does not fit the phase |
| `E_NOT_FOUND` `no-migration` | `run`/`abort` without a plan |
| `E_INVALID_PARAMS` `plan-refused` | the engine refused the plan (e.g. not enough free disk) |
| `E_NOT_AVAILABLE` `switch-unavailable` | no supervisor, a provider the Harness does not run, or a fingerprint the engine would not derive |
| `E_STORAGE` `switch-failed` / `state-corrupt` | the config write failed / the checkpoint is unusable |

## What is not done (open points)

- **Engine prerequisite.** The pinned engine contract does not expose `validate` (the coordinator has it) and its own
  `switch`/`rollback` need a host config-mutation capability this host does not have. The real adapter therefore stops at
  `validating` with `engine-validate-unavailable` (tested against the real engine), and never switches an unvalidated
  generation. The Harness half of the switch is built and tested; it becomes reachable end to end when the engine exposes
  `validate`. The engine's post-switch `completed` transition and rollback are likewise engine work.
- **Confirming the switch / discarding the old generation** is a later explicit step, not part of this package.
- A live run with real models belongs to the nightly (`PLUR1BUS_REAL_MODELS`), not to CI.
