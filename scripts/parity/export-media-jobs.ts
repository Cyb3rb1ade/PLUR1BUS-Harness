import { fileURLToPath } from "node:url";
import { JobRunner } from "../../packages/media/src/jobs.ts";
import type { Job, JobPersistence } from "../../packages/media/src/jobs.ts";
import { MediaError } from "../../packages/media/src/types.ts";
import type { ImageAdapter } from "../../packages/media/src/types.ts";
import type { Manifest, OutputStore } from "../../packages/media/src/store.ts";
import { exporterMain } from "./lib.mjs";

const checkpoint = { id: "fixture-provider-job", model: "fixture-model" };
const progress = { fraction: 0.5, stage: "downloading" } as const;
const manifest = { files: [{ path: "0.png", format: "png", bytes: 3 }] } as Manifest;

export async function recordMediaJobs() {
  const cases = [
    "generate", "edit", "resume", "resume-without-checkpoint", "existing-output",
    "queued-cancel", "pre-aborted", "provider-failure", "invalid-progress",
  ] as const;
  const vectors = [];
  for (const name of cases) {
    const events: unknown[] = [];
    const input: Job = {
      id: "fixture-job", adapter: "fixture-adapter", operation: name === "edit" ? "edit" : "generate",
      request: { prompt: "blue sky", n: 2 },
      state: ["resume", "resume-without-checkpoint", "existing-output"].includes(name) ? "running" : "queued",
      progress: { fraction: 0, stage: "queued" }, createdAt: 100, updatedAt: 100,
      ...(name === "resume" ? { checkpoint } : {}),
    };
    let current = structuredClone(input);
    const projection = (job: Job) => ({
      state: job.state, progress: job.progress, checkpoint: job.checkpoint,
      error: job.error, output: job.output,
    });
    const persistence: JobPersistence = {
      async put(job) {
        current = structuredClone(job);
        events.push(["put", projection(job)]);
      },
      async get() { events.push(["get"]); return structuredClone(current); },
      async list() { return [structuredClone(current)]; },
      async claim() { events.push(["claim"]); return async () => { events.push(["release"]); }; },
    };
    const store = {
      async get() { events.push(["lookup-output"]); return name === "existing-output" ? manifest : null; },
      async put() { events.push(["publish"]); return manifest; },
    } as unknown as OutputStore;
    const adapter = Object.fromEntries(
      (["generate", "edit", "resume"] as const).map((operation) => [operation, async (
        _request: unknown,
        opts: Parameters<NonNullable<ImageAdapter["resume"]>>[1],
      ) => {
        events.push(["adapter", operation, opts.resume]);
        if (name === "provider-failure") throw new MediaError("backend_unavailable");
        await opts.onCheckpoint?.(checkpoint);
        await opts.onProgress?.(name === "invalid-progress" ? { fraction: 1.1 } : progress);
        return { files: [], metadata: { adapter: "fixture-adapter", model: "fixture-model", durationMs: 0 } };
      }]),
    ) as unknown as ImageAdapter;
    Object.defineProperty(adapter, "id", { value: "fixture-adapter" });
    const runner = new JobRunner(persistence, store, [adapter], {
      async reserve(_id, units) { events.push(["reserve", units]); },
      async settle(_id, units) { events.push(["settle", units]); },
    });
    const controller = new AbortController();
    if (name === "pre-aborted") controller.abort();
    if (name === "queued-cancel") await runner.cancel(input.id);
    else await runner.run(input.id, controller.signal);
    vectors.push({ name, input, events, expected: projection(current) });
  }
  return { "job-runner": { source: "packages/media/src/jobs.ts", cases: vectors } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaJobs });
}
