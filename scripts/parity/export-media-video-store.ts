import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { OutputStore } from "../../packages/media/src/store.ts";
import { MediaError } from "../../packages/media/src/types.ts";
import type { VideoProcessor } from "../../packages/media/src/video.ts";
import { exporterMain } from "./lib.mjs";

async function refusal(operation: () => Promise<unknown>) {
  try { await operation(); }
  catch (error) {
    if (error instanceof MediaError) return error.code;
    throw error;
  }
  throw new Error("Expected video publication refusal");
}

export async function recordMediaVideoStore() {
  const root = await mkdtemp(join(tmpdir(), "p4-w-media-video-store-"));
  const now = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const source = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(40)]);
    const request = { durationSeconds: 4, kind: "video" as const, prompt: "Private scene" };
    const metadata = { adapter: "fixture", durationMs: 1, model: "fixture-model" };
    const prompts: Array<string | null> = [];
    const processor: VideoProcessor = async (input, output, poster, options) => {
      prompts.push(options.prompt ?? null);
      const bytes = await readFile(input);
      await writeFile(output, Buffer.concat([bytes, Buffer.from(options.prompt ?? "")]));
      await writeFile(poster, "poster");
      return { durationSeconds: 4, width: 1280, height: 720, fps: 24, audio: false };
    };
    const result = () => ({ files: [{ format: "mp4" as const, bytes: Buffer.alloc(0),
      stream: (async function*() { yield source.subarray(0, 10); yield source.subarray(10); })() }], metadata });
    const makeStore = (options: OutputStore["options"] = {}) => new OutputStore(root, { videoProcessor: processor, ...options });
    const store = makeStore();
    const plain = await store.put("off", request, result());
    const optIn = await store.put("on", { durationSeconds: request.durationSeconds,
      embedMetadata: true, kind: request.kind, prompt: request.prompt }, result());
    const maxVideo = await refusal(() => makeStore({ maxVideoBytes: 10 }).put("large", request, result()));
    const quota = await refusal(() => makeStore({ quotaBytes: 1 }).put("quota", request, result()));
    const used = [plain, optIn].reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify(m))
      + m.files.reduce((total, file) => total + file.bytes + (file.poster?.bytes ?? 0), 0), 0);
    const lateQuota = await refusal(() => makeStore({ quotaBytes: used + source.length })
      .put("late-quota", request, result()));
    const invalid = await refusal(() => store.put("invalid", request, { ...result(),
      files: [{ bytes: Buffer.from("bad"), format: "mp4" }] }));
    return { "video-store": {
      source: "packages/media/src/store.ts",
      input: { bytes: source.toString("base64"), now, request, metadata },
      expected: { plain, optIn, prompts, maxVideo, quota, lateQuota, invalid, entries: (await readdir(root)).sort(),
        plainBytes: (await readFile(join(root, "off", "0.mp4"))).toString("base64"),
        optInBytes: (await readFile(join(root, "on", "0.mp4"))).toString("base64") },
    } };
  } finally {
    Date.now = realNow;
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaVideoStore });
}
