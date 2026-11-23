import { fileURLToPath } from "node:url";
import { HttpImageAdapter, type HttpAdapterId } from "../../packages/media/src/adapters.ts";
import type { GenerationContext, VideoRequest } from "../../packages/media/src/types.ts";
import { fakeServer, json } from "../../packages/media/test/adapters-fixtures.ts";
import { exporterMain } from "./lib.mjs";

export const videoProviders = ["google", "openrouter", "xai", "replicate", "fal"] as const;
type Provider = typeof videoProviders[number];

export async function recordMediaVideoWire() {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(40)]);
  const record: Record<string, unknown> = {};
  for (const id of videoProviders) {
    const model = id === "replicate" || id === "fal" ? "owner/fixture" : "fixture-model";
    const request: VideoRequest = { kind: "video", prompt: "A short scene 🌳", durationSeconds: 4 };
    const inputSchema = { prompt: { type: "string" }, duration: { type: "number", minimum: 1, maximum: 5 } };
    const capabilities = { textToVideo: true, imageToVideo: true, videoToVideo: id !== "openrouter",
      durationSeconds: [1, 5] as [number, number], inputSchema };
    const replies: unknown[] = [];
    let base = "";
    let polls = 0;
    const server = await fakeServer((call, response) => {
      if (call.path === "/asset" || call.path.endsWith("/content")) {
        const headers = { "content-type": "video/mp4" };
        replies.push({ status: 200, headers, chunksBase64: [mp4.subarray(0, 10).toString("base64"), mp4.subarray(10).toString("base64")] });
        response.writeHead(200, headers);
        response.write(mp4.subarray(0, 10));
        response.end(mp4.subarray(10));
        return;
      }
      const idPath = "fixture-id";
      const submitted: Record<Provider, unknown> = {
        google: { name: "operations/" + idPath },
        openrouter: { id: idPath, status: "queued" },
        xai: { request_id: idPath },
        replicate: { id: idPath, status: "queued" },
        fal: { request_id: idPath },
      };
      const completed: Record<Provider, unknown> = {
        google: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: base + "/asset" } }] } } },
        openrouter: { status: "completed" },
        xai: { status: "done", video: { url: base + "/asset" } },
        replicate: { status: "succeeded", output: base + "/asset" },
        fal: call.path.endsWith("/status") ? { status: "COMPLETED" } : { video: { url: base + "/asset" } },
      };
      let body: unknown;
      if (call.method === "POST") body = submitted[id];
      else if (call.path === "/models/owner/fixture") body = { openapi_schema: { components: { schemas: { Input: { properties: inputSchema } } } } };
      else if (call.path === "/videos/models") body = { data: [{ id: model, supported_durations: [4] }] };
      else if (++polls === 1) body = id === "google" ? { done: false } : { status: "running", progress: 20 };
      else body = completed[id];
      replies.push({ status: 200, body });
      json(response, 200, body);
    });
    base = server.url;
    try {
      const progress: unknown[] = [];
      const checkpoints: unknown[] = [];
      const waits: number[] = [];
      const context: GenerationContext = { signal: AbortSignal.timeout(3000),
        onProgress: async (event) => { progress.push(event); },
        onCheckpoint: async (event) => { checkpoints.push(event); },
      };
      const adapter = new HttpImageAdapter({ id: id as HttpAdapterId, model, baseUrl: base, video: capabilities, pollMs: 7,
        pollWait: async (ms, signal) => { signal.throwIfAborted(); waits.push(ms); } });
      const result = await adapter.generate(request, context);
      const chunks: Buffer[] = [];
      for await (const chunk of result.files[0]!.stream!) chunks.push(Buffer.from(chunk));
      const { durationMs: _duration, origin: _origin, ...metadata } = result.metadata;
      record["video-wire-" + id] = {
        schema: "plur1bus.parity-wire/1", transport: "http",
        input: { id, model, request, capabilities },
        expected: { metadata, progress, checkpoints, waits, bytes: Buffer.concat(chunks).toString("base64") },
        exchanges: server.calls.map((call, index) => ({
          request: { method: call.method, path: call.path, bodyText: call.body,
            headers: { ...(call.headers["content-type"] ? { "content-type": call.headers["content-type"] } : {}) } },
          response: JSON.parse(JSON.stringify(replies[index]).replaceAll(base, "<fixture-origin>")),
        })),
      };
    } finally {
      await server.close();
    }
  }
  return record;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaVideoWire });
}
