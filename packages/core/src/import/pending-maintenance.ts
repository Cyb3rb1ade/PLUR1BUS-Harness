/** Every Engine owner refuses an interrupted target until the private maintenance worker restores its baseline. */
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readMaintenanceJournal } from "./maintenance-journal.ts";
import { ImportError } from "./types.ts";

const RUN = /^[A-Za-z0-9_-]{1,64}$(?![\s\S])/;
const required = () => new ImportError("E_CONFLICT", "maintenance-recovery-required", "Import maintenance requires recovery");

/** The exception is a trusted in-process port, never a CLI option, public RPC parameter or environment variable. */
export function assertNoPendingMaintenance(home: string, allowedRunId?: string): void {
  try {
    if (!isAbsolute(home) || allowedRunId !== undefined && !RUN.test(allowedRunId)) throw required();
    const directory = join(home, "imports");
    const info = lstatSync(directory, { throwIfNoEntry: false });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw required();
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length > 10_000) throw required();
    for (const entry of entries) {
      if (!RUN.test(entry.name)) continue;
      if (entry.isSymbolicLink()) throw required();
      if (!entry.isDirectory()) continue;
      const file = join(directory, entry.name, "maintenance.json");
      if (!lstatSync(file, { throwIfNoEntry: false })) continue;
      const journal = readMaintenanceJournal(home, entry.name);
      if (entry.name === allowedRunId) continue;
      const dirty = ["applying", "rolling-back", "snapshot-complete"].includes(journal.phase)
        || ["prepared", "snapshotting"].includes(journal.phase) && (!!journal.snapshotSha256 || journal.secrets.length > 0)
        || journal.phase === "restored" && journal.secrets.some(secret => secret.created && !secret.removed);
      if (dirty) throw required();
    }
  } catch {
    // A torn, linked, unreadable or newer record is not evidence that the target can be opened safely.
    throw required();
  }
}
