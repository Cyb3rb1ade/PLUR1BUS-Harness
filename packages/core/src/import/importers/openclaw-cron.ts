// Reading user-authored cron jobs from OpenClaw state database (docs/import.md §2.2, §2.2.1).
// Excludes managed dreaming and feature cron jobs. Zero prompt content, job names, delivery targets or secret values are reported.
import { join } from "node:path";
import { isFile, openSqliteReadOnly, sqliteTables } from "../readonly.ts";

export interface OpenclawCronJob {
  id: string;
  schedule: string;
  // Platform/keyword prefix of the delivery target only; the target itself (a chat/user id) is never reported.
  deliverKind: string | null;
  status: "deferred";
}

const DELIVER_KINDS = new Set([
  "telegram", "discord", "slack", "whatsapp", "signal", "matrix", "mattermost", "irc", "imessage", "email",
  "webhook", "last", "none", "announce",
]);

export function deliverKind(deliver: string | null): string | null {
  if (!deliver) return null;
  const kind = deliver.split(":", 1)[0]!.trim().toLowerCase();
  return DELIVER_KINDS.has(kind) ? kind : "other";
}

const MANAGED_PREFIXES = ["memory-core:"];
const MANAGED_NAMES = ["managed-dreaming", "memory-dreaming-promotion"];
const FEATURE_CRONS = new Set([
  "persona-evolve", "afterthought", "consolidate-daily", "auto-accept-stale",
  "embedding-drain", "emotion-refine", "classify-recent", "rem-dream",
  "skill-miner", "discover-semantic-links", "gc-run",
]);

export function isManagedCron(id: string, name: string): boolean {
  if (MANAGED_PREFIXES.some((p) => id.startsWith(p))) return true;
  if (MANAGED_NAMES.includes(name) || MANAGED_NAMES.includes(id)) return true;
  if (FEATURE_CRONS.has(id) || FEATURE_CRONS.has(name)) return true;
  return false;
}

export function readOpenclawCronJobs(root: string): { userJobs: OpenclawCronJob[]; excludedCount: number } {
  const p = join(root, "state", "openclaw.sqlite");
  if (!isFile(p)) return { userJobs: [], excludedCount: 0 };
  const h = openSqliteReadOnly(p);
  try {
    const tables = sqliteTables(h.db);
    if (!tables.includes("cron_jobs")) return { userJobs: [], excludedCount: 0 };
    const rows = h.db.prepare("SELECT * FROM cron_jobs").all() as Record<string, unknown>[];
    const userJobs: OpenclawCronJob[] = [];
    let excludedCount = 0;
    for (const r of rows) {
      const id = String(r.id ?? "");
      const name = String(r.name ?? id);
      const schedule = String(r.schedule ?? "");
      const deliver = r.deliver ? String(r.deliver) : (r.delivery ? String(r.delivery) : null);
      if (isManagedCron(id, name)) {
        excludedCount++;
        continue;
      }
      userJobs.push({
        id,
        schedule,
        deliverKind: deliverKind(deliver),
        status: "deferred",
      });
    }
    userJobs.sort((a, b) => a.id.localeCompare(b.id));
    return { userJobs, excludedCount };
  } finally {
    h.close();
  }
}
