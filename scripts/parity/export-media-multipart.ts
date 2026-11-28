import { fileURLToPath } from "node:url";
import { HttpImageAdapter } from "../../packages/media/src/adapters.ts";
import { makeLeakyPng, makePng } from "../../packages/media/test/adapters-fixtures.ts";
import { json, startFakeVendor } from "../../packages/voice-providers/test/helpers/fake-vendor.ts";
import { exporterMain } from "./lib.mjs";

export async function recordMediaMultipart() {
  const reference = makeLeakyPng();
  const output = makePng().toString("base64");
  const reply = { data: [{ b64_json: output }] };
  const server = await startFakeVendor({ http: (_req, response) => json(response, 200, reply) });
  const boundary = "fixture-multipart-boundary";
  try {
    const model = "fixture-model";
    const parameters = { prompt: "Two lines\nBäume 🌳", format: "png" as const, size: { width: 128, height: 256 } };
    const format = "png" as const;
    const adapter = new HttpImageAdapter({ id: "openai", model, baseUrl: server.httpUrl });
    const result = await adapter.edit({ ...parameters,
      referenceImages: [{ bytes: reference, format }], mask: { bytes: reference, format },
    }, { signal: AbortSignal.timeout(2000) });
    const request = server.requests[0]!;
    const mime = request.headers["content-type"];
    const actualBoundary = typeof mime === "string" ? mime.split("boundary=")[1] : undefined;
    if (!actualBoundary) throw new Error("Missing multipart boundary in TypeScript recording");
    const normalized = Buffer.from(request.body.toString("latin1").replaceAll(actualBoundary, boundary), "latin1");
    return { "image-multipart": { schema: "plur1bus.parity-wire/1", transport: "http",
      input: { model, parameters, image: reference.toString("base64"), boundary },
      expected: { bytes: Buffer.from(result.files[0]!.bytes).toString("base64") },
      exchanges: [{ request: { method: request.method, path: request.url,
        headers: { "content-type": "multipart/form-data; boundary=" + boundary },
        bodyBase64: normalized.toString("base64") }, response: { status: 200, body: reply } }],
    } };
  } finally {
    await server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaMultipart });
}
