/** C6 writes only missing allowlisted targets; durable intent and backend run metadata prove every rollback deletion. */
import type { SecretStore } from "../secrets/store.ts";
import type { ImportMaintenanceJournal } from "./maintenance-journal.ts";
import { checkImportAbort } from "./execution.ts";
import { isImportSecretName, type ImportSecretLease } from "./source-secrets.ts";
import { ImportError } from "./types.ts";

type ImportSecretStore = Pick<SecretStore, "status" | "set" | "delete">;
const unavailable = () => new ImportError("E_NOT_AVAILABLE", "secret-store-unavailable",
  "Import secret store is unavailable");

async function metadata(store: ImportSecretStore) {
  const status = await store.status({ kind: "core" });
  if (status.backend === "none" || !Array.isArray(status.secrets)) throw unavailable();
  return status.secrets;
}

function actor(runId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$(?![\s\S])/.test(runId)) throw unavailable();
  return { kind: "owner" as const, id: `import:${runId}` };
}

export async function migrateImportSecrets(options: {
  runId: string;
  store: ImportSecretStore;
  journal: ImportMaintenanceJournal;
  lease: ImportSecretLease;
  signal?: AbortSignal;
}): Promise<{ imported: string[]; skipped: string[] }> {
  const imported: string[] = [];
  const skipped: string[] = [];
  try {
    const principal = actor(options.runId);
    for (const [name, bytes] of options.lease.entries()) {
      checkImportAbort(options.signal);
      if (!isImportSecretName(name)) throw unavailable();
      // The target remains a single writer throughout maintenance. Recheck immediately before durable absent intent.
      if ((await metadata(options.store)).some(value => value.name === name)) {
        skipped.push(name);
        bytes.fill(0);
        continue;
      }
      options.journal.secretIntent(name);
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      await options.store.set(principal, name, value);
      options.journal.secretCreated(name);
      imported.push(name);
      bytes.fill(0);
    }
    return { imported, skipped };
  } catch (error) {
    if (error instanceof ImportError && error.reason === "aborted") throw error;
    throw unavailable();
  } finally {
    options.lease.release();
  }
}

/** No value is revealed. A later rotation by another actor is a conflict, never permission to remove its value. */
export async function rollbackImportSecrets(options: {
  runId: string;
  store: ImportSecretStore;
  journal: ImportMaintenanceJournal;
}): Promise<void> {
  try {
    const principal = actor(options.runId);
    for (const intent of options.journal.read().secrets) {
      if (!isImportSecretName(intent.name) || intent.absentBefore !== true) throw unavailable();
      if (intent.removed) continue;
      const current = (await metadata(options.store)).find(value => value.name === intent.name);
      if (!current) {
        if (intent.created) options.journal.secretRemoved(intent.name);
        continue;
      }
      if (current.updatedBy !== principal.id) {
        if (intent.created) throw new ImportError("E_CONFLICT", "secret-changed", "Imported secret has changed");
        continue;
      }
      // An OS write may have committed just before a crash prevented the created receipt. The durable absent intent
      // plus exact backend actor proves this run's ownership, so recovery can finish its receipt and delete safely.
      if (!intent.created) options.journal.secretCreated(intent.name);
      await options.store.delete(principal, intent.name);
      options.journal.secretRemoved(intent.name);
    }
  } catch (error) {
    if (error instanceof ImportError && error.reason === "secret-changed") throw error;
    throw unavailable();
  }
}
