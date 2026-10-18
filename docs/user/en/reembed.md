# Switching embedding models (memory reembed)

When you change the embedding model, the memory store has to be re-embedded into the new vector space. `plur1bus memory reembed` does this without a mixed vector space: it builds a new generation of vectors next to the old one and switches only after checking it. The German version of this page is [../de/reembed.md](../de/reembed.md).

> **Availability:** the migration is experimental. Moving to a **local** model works as described below. Moving to or between **cloud** models (`--provider`, `--base-url`, `--api-key-env`, `--acknowledge-privacy`) is available from the next release.
>
> **Open point:** the memory engine does not yet offer the validation step the switch needs. Until it does, a run stops in the phase `validating` (`engine-validate-unavailable`) and never switches an unvalidated generation. The old store stays active.

## How to

There is no web UI for this. Use the CLI.

1. Plan the migration. This copies nothing and prints a verdict, the number of rows and batches, the disk space needed and the minimum time. The verdict `incompatible` ends with exit code 1 and names the reasons.

```sh
plur1bus memory reembed --plan --model <MODEL> --dimensions <N>
```

`--model` is a pinned local embedding model. `--dimensions` is only needed when the model supports more than one size.

2. Run it. The command asks for confirmation (`--yes` outside a terminal), starts the migration inside the core and follows its progress. `--no-wait` returns after the start, `--no-switch` copies and validates but does not switch, `--throttle-ms` sets the pause between batches (default 250).

```sh
plur1bus memory reembed --run
```

3. Check the phase and progress:

```sh
plur1bus memory reembed --status
```

4. Stop at the next batch boundary:

```sh
plur1bus memory reembed --abort
```

Running `plur1bus memory reembed --run` again continues the same migration; a halted run (engine error, core stop) is resumed the same way.

## Good to know

- **Per installation:** the migration copies every agent's memory into one new generation. There is no per-agent option.
- **The old generation stays active:** recall is answered by the old generation until the configuration is replaced in one step after validation. The old generation is kept on disk.
- **Phases:** `planned`, `running`, `validating`, `ready-to-switch`, `switched`; plus `aborted` (stopped, can be resumed) and `failed` (final, plan again).
- **One operation at a time:** while a plan, run or switch is in progress, another one is refused.
- **Cloud targets (from the next release):** every direction works: local to cloud, cloud to local, cloud to cloud. The plan shows that all card texts go to the provider, the estimated tokens and the estimated cost. The target needs the privacy confirmation (`memory.embedding.privacyAck`, or `--acknowledge-privacy` at plan time); "Local only" refuses a cloud target; the endpoint must pass the egress rules ([privacy.md](privacy.md)). Keys are given as the name of an environment variable, never as a value ([cloud-embeddings.md](cloud-embeddings.md)).
- **Budget stop (cloud targets):** before each batch the estimated tokens are reserved in the call budget `memory-reembed`. A hard limit pauses the run in the phase `aborted` with the error `budget-exceeded`; `--run` continues once the budget allows it ([budgets.md](budgets.md)). A rate limit or a transient provider error is retried with growing pauses before the run halts.
- **No silent fallback:** vectors of different models are never mixed. Recall uses only the active, validated generation.

## Error messages

The migration reports the closed error codes; the `reason` says what applied.

- `E_CONFLICT` with reason `migration-active` or `migration-running`: another plan, run or switch is in progress. Look at `--status`, or stop it with `--abort`.
- `E_CONFLICT` with reason `not-runnable`, `not-abortable` or `not-ready-to-switch`: the call does not fit the current phase.
- `E_NOT_FOUND` with reason `no-migration`: `--run` or `--abort` without a plan. Plan first.
- `E_INVALID_PARAMS` with reason `plan-refused`: the engine refused the plan, for example because there is not enough free disk space.
- `E_NOT_AVAILABLE` with reason `switch-unavailable`: nothing was written and the old configuration stays active (no supervisor, or a target the engine would not start with).
- `E_STORAGE` with reason `switch-failed`, `state-corrupt` or `state-unreadable`: the configuration could not be written, or the checkpoint file is unusable.
- From the next release, for cloud targets: `E_DENIED` with reason `privacy-acknowledgment-required`, `local-only` or `egress-denied`, and `E_INVALID_PARAMS` with reason `engine-provider-config-incomplete`.

## Next

- Cloud embeddings and rerankers: [cloud-embeddings.md](cloud-embeddings.md)
- Spending budgets: [budgets.md](budgets.md)
- Routine memory maintenance: [operations.md](operations.md)
