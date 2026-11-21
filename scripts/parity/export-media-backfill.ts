import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBackfillJob, type BackfillConfig } from "../../packages/core/src/media-search/backfill.ts";
import type { MediaIndexPort, MediaIndexStatus } from "../../packages/core/src/media-search/types.ts";
import { exporterMain } from "./lib.mjs";

async function one(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "media-bf-vector-"));
  try {
    const stateFile = join(dir, "state", "media-search.json");
    const status: MediaIndexStatus = {
      enabled: true, provider: "local", model: "test", dim: 1, fingerprint: "p1",
      counts: { indexed: 0, pending: 2, failed: 0, unsupported: 0 },
      backfill: { state: "idle", done: 0, total: 2 },
    };
    const calls: unknown[] = [], events: unknown[] = [];
    const cfg: BackfillConfig = { enabled: true, provider: "local", backfill: "auto" };
    if (["same", "changed", "corrupt"].includes(name)) {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, name === "corrupt" ? "broken" : JSON.stringify({ fingerprint: name === "same" ? "p1" : "p0" }));
    }
    if (name === "done") status.backfill = { state: "done", done: 2, total: 2 };
    if (name === "running") status.backfill.state = "running";
    if (["user", "budget", "error"].includes(name))
      status.backfill = { state: "paused", done: 1, total: 2, pausedReason: name as "user" | "budget" | "error" };
    if (name === "disabled") cfg.enabled = false;
    if (name === "off") cfg.provider = "off";
    if (name === "manual") cfg.backfill = "manual";
    const before = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null;
    const initial = structuredClone(status);
    const port: MediaIndexPort = {
      index: async () => { throw new Error("unexpected"); }, search: async () => [],
      remove: async () => {}, setCaption: async () => {}, status: async () => structuredClone(status),
      backfill: {
        async start({ reason }) { calls.push(["start", reason]); status.backfill.state = "running"; },
        async resume() { calls.push("resume"); status.backfill.state = "running"; delete status.backfill.pausedReason; },
        async cancel() { calls.push("cancel"); status.backfill.state = "cancelled"; },
        async pause() { calls.push("pause"); status.backfill.state = "paused"; status.backfill.pausedReason = "user"; },
      },
    };
    const job = createBackfillJob({ port: () => port, config: () => cfg, stateFile,
      events: { emit: (name, payload) => { events.push({ name, payload }); } }, logger: { warn: () => {} } });
    let outcome: unknown;
    switch (name) {
      case "reindex": outcome = await job.reindex(); break;
      case "changes":
        await job.poll(); await job.poll(); status.model = "other"; await job.poll(); status.counts.indexed++;
        outcome = await job.poll(); break;
      case "controls": await job.pause(); await job.resume(); outcome = await job.cancel(); break;
      default: outcome = await job.init();
    }
    return { name, cfg, initial, before, outcome, calls, events, after: existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function buildMediaBackfillVectors() {
  return { backfill: await Promise.all(["first", "same", "changed", "corrupt", "done", "running", "user", "budget", "error", "manual",
    "disabled", "off", "reindex", "controls", "changes"].map(one)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "media", build: buildMediaBackfillVectors });
}
