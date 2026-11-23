import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileJobPersistence, JobRunner } from "../../packages/media/src/jobs.ts";
import type { ImageAdapter, ImageRequest } from "../../packages/media/src/types.ts";
import type { OutputStore } from "../../packages/media/src/store.ts";
import { makePng } from "../../packages/media/test/adapters-fixtures.ts";
import { exporterMain } from "./lib.mjs";

export async function recordMediaJobInputs() {
  const root = await mkdtemp(join(tmpdir(), "p4-w-job-inputs-"));
  const png = makePng();
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
  const requests: ImageRequest[] = [
    { prompt: "Edit fixture", referenceImages: [{ bytes: png, format: "png" },
      { bytes: Uint8Array.from(png), format: "png" }], mask: { bytes: Uint8Array.from(png), format: "png" } },
    { prompt: "Video fixture", kind: "video", durationSeconds: 4, referenceVideo: { bytes: mp4, format: "mp4" } },
  ];
  const summarize = (request: ImageRequest) => {
    const encoded = (source: { format: string, bytes: Uint8Array }) =>
      ({ format: source.format, bytes: Buffer.from(source.bytes).toString("base64") });
    const { referenceImages, mask, referenceVideo, ...parameters } = request;
    return { parameters, references: (referenceImages ?? []).map(encoded),
      mask: mask ? encoded(mask) : null, referenceVideo: referenceVideo ? encoded(referenceVideo) : null };
  };
  try {
    const cases = [];
    for (const request of requests) {
      const persistence = new FileJobPersistence(root);
      const events: unknown[] = [];
      const edit: ImageAdapter["edit"] = async (input) => {
        events.push(["adapter", summarize(input)]);
        return { files: [], metadata: { adapter: "fixture", model: "sample", durationMs: 0 } };
      };
      const adapter: ImageAdapter = { id: "fixture", generate: edit, edit,
        capabilities: () => ({ generate: true, edit: true, inpaint: true }) };
      const store = {
        async get() { return null; },
        async put(_id: string, input: ImageRequest) {
          events.push(["publish", summarize(input)]);
          return { files: [request.kind === "video" ? { durationSeconds: 3.5 } : {}] };
        },
      } as unknown as OutputStore;
      const runner = new JobRunner(persistence, store, [adapter], {
        async reserve(_id, units) { events.push(["reserve", units]); },
        async settle(_id, units) { events.push(["settle", units]); },
      });
      const queued = await runner.enqueue("fixture", request, "edit");
      const persisted = JSON.parse(await readFile(join(root, queued.id + ".json"), "utf8"));
      const input = { ...persisted, id: "fixture-job", createdAt: 100, updatedAt: 100 };
      await runner.run(queued.id);
      const state = (await persistence.get(queued.id))?.state;
      cases.push({ input, expected: { events, state } });
    }
    return { "job-inputs": { source: "packages/media/src/jobs.ts", cases } };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaJobInputs });
}
