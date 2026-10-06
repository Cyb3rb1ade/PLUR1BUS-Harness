// Hermes cron jobs reader (docs/import.md §3.3, M7 Batch 3).
// Reads cron/jobs.json across Hermes root and profiles.
// Reports user-authored jobs as "deferred" (id, schedule, deliverKind only; zero disk writes; prompt text and target IDs excluded).
import { join } from "node:path";
import { deliverKind } from "./openclaw-cron.ts";
import { readHermesSourceFileSafe } from "./hermes-fs-safe.ts";

export interface HermesCronJob {
  id: string;
  schedule: string;
  deliverKind: string | null;
  status: "deferred";
  sourceProfile?: string | undefined;
}

export function readHermesCronJobs(
  profiles: Array<{ agentId: string; dir: string }>,
  errors?: Array<{ sourceRef: string; reason: string }>,
): {
  userJobs: HermesCronJob[];
  excludedCount: number;
} {
  const userJobs: HermesCronJob[] = [];
  let excludedCount = 0;
  const seenJobIds = new Set<string>();

  for (const p of profiles) {
    const cronFile = join(p.dir, "cron", "jobs.json");
    const readRes = readHermesSourceFileSafe(cronFile, 1024 * 1024);
    if (!readRes.ok) {
      if (readRes.error !== "not-found") errors?.push({ sourceRef: `${p.agentId}:cron/jobs.json`, reason: readRes.error });
      continue;
    }

    try {
      const data = JSON.parse(readRes.content);
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

      for (const j of jobs) {
        if (!j || typeof j !== "object") continue;
        const id = typeof j.id === "string" ? j.id.trim() : "";
        const schedule = typeof j.schedule === "string" ? j.schedule.trim() : "";

        if (!id || !schedule) {
          excludedCount++;
          continue;
        }

        const dedupKey = `${p.agentId}:${id}`;
        if (seenJobIds.has(dedupKey)) {
          excludedCount++;
          continue;
        }
        seenJobIds.add(dedupKey);

        const rawDeliver = typeof j.deliver === "string" ? j.deliver : (typeof j.delivery === "string" ? j.delivery : null);

        userJobs.push({
          id,
          schedule,
          deliverKind: deliverKind(rawDeliver),
          status: "deferred",
          sourceProfile: p.agentId,
        });
      }
    } catch {
      // Ignored safely
    }
  }

  return { userJobs, excludedCount };
}
