# Switching embedding models (memory reembed)

When you change your embedding model, existing memory cards must be re-embedded into the new vector space. Plur1bus supports full migration in all directions: local↔cloud, cloud→cloud, and local→local. The German version of this page is [../de/reembed.md](../de/reembed.md).

## How to ("So geht's")

### Web UI

1. Open **Memories & Dreams** (`#/memories`).
2. Under the **Store & Embeddings** status panel, click **Switch Embedding Model**.
3. Select your target model and desired vector dimensions.
4. Click **Plan Migration**: The preview shows card counts, estimated tokens, and dimension changes without altering data.
5. Click **Start Migration**: Batches are processed in the background. A progress bar shows active batch status.
6. You can pause at any time; your existing store remains active until migration completes.

### CLI

1. Plan the migration (dry-run):

```sh
plur1bus memory reembed --plan --model <MODEL>
```

2. Execute the migration:

```sh
plur1bus memory reembed --run
```

3. Check migration status and progress:

```sh
plur1bus memory reembed --status
```

4. Safely pause or abort a running migration:

```sh
plur1bus memory reembed --abort
```

Running `plur1bus memory reembed --run` again will resume from the last completed batch boundary.

## Good to know ("Gut zu wissen")

- **All directions supported:** You can migrate from a local model (such as `bge-small-en-v1.5`) to a cloud model (`text-embedding-3-small`), between different cloud providers, or back to a local model.
- **Old generation stays intact:** Migration builds a new generation in the background. While `reembed --run` is working, queries continue to use the old generation. The switch happens atomically only after 100% of cards are verified.
- **Budget stop:** If an API quota is exhausted or a budget limit is reached during a cloud migration, the process pauses cleanly at the current batch boundary without data loss.
- **No silent fallback:** Plur1bus never mixes vectors from different models. Queries use only the active, fully validated generation.

## Error messages ("Fehlermeldungen")

- `E_STORE_INCOMPATIBLE`: The store's vector dimension or fingerprint does not match the active model configuration. Run `plur1bus memory reembed --plan` to prepare a migration.
- `E_BUDGET_EXCEEDED`: Migration halted because the allocated token or monetary budget limit was reached.
- `E_MIGRATION_IN_PROGRESS`: A migration is already running. Check progress with `--status` or stop it with `--abort` before starting a new run.

## Next

- Learn about cloud embeddings: [cloud-embeddings.md](cloud-embeddings.md)
- Configure spending budgets: [budgets.md](budgets.md)
- Routine memory maintenance: [operations.md](operations.md)
