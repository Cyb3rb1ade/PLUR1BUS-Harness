// Hermes cron jobs reader (docs/import.md §3.3, M7 Batch 3).
// Reads cron/jobs.json across Hermes root and profiles.
// Reports user-authored jobs as "deferred" (id, schedule only; zero disk writes; prompt text excluded).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFile } from "../readonly.ts";

export interface HermesCronJob {
  id: string;
  schedule: string;
  deliver?: string | undefined;
  sourceProfile?: string | undefined;
}

export function readHermesCronJobs(profiles: Array<{ agentId: string; dir: string }>): {
  userJobs: HermesCronJob[];
  excludedCount: number;
} {
  const userJobs: HermesCronJob[] = [];
  let excludedCount = 0;
  const seenJobIds = new Set<string>();

  for (const p of profiles) {
    const cronFile = join(p.dir, "cron", "jobs.json");
    if (!isFile(cronFile)) continue;

    try {
      const raw = readFileSync(cronFile, "utf8");
      const data = JSON.parse(raw);
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

        userJobs.push({
          id,
          schedule,
          deliver: typeof j.deliver === "string" ? j.deliver.trim() : undefined,
          sourceProfile: p.agentId,
        });
      }
    } catch {
      // Ignored safely
    }
  }

  return { userJobs, excludedCount };
}
