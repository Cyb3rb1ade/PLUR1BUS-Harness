import { fileURLToPath } from "node:url";
import { HttpImageAdapter, type HttpAdapterId } from "../../packages/media/src/adapters.ts";
import type { ImageRequest, GenerationContext } from "../../packages/media/src/types.ts";
import { fakeServer, json, makePng } from "../../packages/media/test/adapters-fixtures.ts";
import { exporterMain } from "./lib.mjs";

export const imageProviders: readonly HttpAdapterId[] =
  ["openai", "openrouter", "google", "xai", "together", "draw-things", "replicate", "fal"];

export async function recordMediaImageWire() {
  const pixels = makePng().toString("base64");
  const dataUrl = "data:image/png;base64," + pixels;
  const record: Record<string, unknown> = {};
  for (const id of imageProviders) {
    const model = id === "replicate" || id === "fal" ? "owner/fixture" : "fixture-model";
    const request: ImageRequest = {
      prompt: "A paper tree 🌳",
      ...(id === "openai" || id === "together" || id === "fal" ? { size: { width: 256, height: 256 } } : {}),
      ...(id === "openrouter" || id === "google" || id === "replicate" ? { aspect: "1:1" } : {}),
      ...(id === "draw-things" || id === "together" || id === "replicate" || id === "fal" ? { seed: 7 } : {}),
    };
    const results: Record<HttpAdapterId, unknown[]> = {
      openai: [{ data: [{ b64_json: pixels }] }],
      openrouter: [{ choices: [{ message: { images: [{ image_url: { url: dataUrl } }] } }] }],
      google: [{ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: pixels } }] } }] }],
      xai: [{ data: [{ b64_json: pixels }] }],
      together: [{ data: [{ b64_json: pixels }] }],
      "draw-things": [{ images: [pixels] }],
      replicate: [{}, { id: "fixture-id", status: "starting" }, { status: "running" }, { status: "succeeded", output: dataUrl }],
      fal: [{ request_id: "fixture-id" }, { status: "IN_QUEUE" }, { status: "COMPLETED" }, { images: [{ url: dataUrl }] }],
    };
    const bodies = results[id];
    const server = await fakeServer((_call, response, index) => json(response, 200, bodies[index]));
    try {
      const progress: unknown[] = [];
      const checkpoints: unknown[] = [];
      const context: GenerationContext = {
        signal: AbortSignal.timeout(2000),
        onProgress: async (event) => { progress.push(event); },
        onCheckpoint: async (event) => { checkpoints.push(event); },
      };
      const adapter = new HttpImageAdapter({ id, model, baseUrl: server.url, pollMs: 1 });
      const outcome = await adapter.generate(request, context);
      if (server.calls.length !== bodies.length) throw new Error("Incomplete image adapter recording " + id);
      const { durationMs: _durationMs, origin: _origin, ...metadata } = outcome.metadata;
      record["image-wire-" + id] = {
        schema: "plur1bus.parity-wire/1", transport: "http", input: { id, model, request },
        expected: { metadata, progress, checkpoints, partial: outcome.partial,
          files: outcome.files.map((file) => ({ format: file.format, bytes: Buffer.from(file.bytes).toString("base64") })) },
        exchanges: server.calls.map((call, index) => ({
          request: { method: call.method, path: call.path, bodyText: call.body,
            headers: { ...(call.headers["content-type"] ? { "content-type": call.headers["content-type"] } : {}) } },
          response: { status: 200, body: bodies[index] },
        })),
      };
    } finally {
      await server.close();
    }
  }
  return record;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaImageWire });
}
