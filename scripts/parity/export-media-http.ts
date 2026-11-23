import { fileURLToPath } from "node:url";
import { ResilientTransport } from "../../packages/media/src/adapters/_shared/transport.ts";
import { reasonOf } from "../../packages/media/src/adapters/_shared/errors.ts";
import { MediaError } from "../../packages/media/src/types.ts";
import { fakeServer, json, makePng, recordingSleep } from "../../packages/media/test/adapters-fixtures.ts";
import { exporterMain } from "./lib.mjs";

export async function recordMediaHttp() {
  const png = makePng();
  const replies = [
    { status: 429, headers: { "retry-after": "0.125" }, body: { error: "quota" } },
    { status: 503, headers: undefined, body: { error: "fixture unavailable" } },
    { status: 200, headers: undefined, body: { models: ["example"] } },
    { status: 503, headers: undefined, body: { error: "fixture unavailable" } },
    { status: 401, headers: undefined, body: { error: "fixture credential rejected" } },
    { status: 403, headers: undefined, body: { error: "rejected by content policy" } },
    { status: 200, headers: { "content-type": "image/png" }, chunksBase64: [png.toString("base64")] },
  ];
  const server = await fakeServer((_call, response, index) => {
    const reply = replies[index]!;
    if (reply.chunksBase64) {
      response.writeHead(reply.status, reply.headers);
      response.end(png);
    } else json(response, reply.status, reply.body, reply.headers);
  });
  try {
    const sleeper = recordingSleep();
    const client = new ResilientTransport(server.url + "/v1", undefined, {
      adapter: "openai", retry: { ...sleeper, random: () => 0.25 },
    });
    const signal = AbortSignal.timeout(2000);
    const success = await client.json("models", undefined, signal);
    const submission = { prompt: "A tree 🌳" };
    const failure = async (path: string, body?: unknown) => {
      try { await client.json(path, body, signal); }
      catch (error) {
        if (!(error instanceof MediaError)) throw error;
        return { code: error.code, ...(reasonOf(error) ? { reason: reasonOf(error) } : {}) };
      }
      throw new Error("Expected HTTP refusal");
    };
    const declined = await failure("generate", submission);
    const credential = await failure("account");
    const moderation = await failure("guard");
    const image = await client.image(server.url + "/image", "png", signal);
    const checkPreviousBound = await fakeServer((_call, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: "a".repeat(1024 * 1024) }));
    });
    let oldLimitLength: number;
    try {
      const body = await new ResilientTransport(checkPreviousBound.url, undefined, { adapter: "openai" })
        .json("models", undefined, AbortSignal.timeout(3000));
      if (typeof body.models !== "string") throw new Error("Expected the TypeScript size case to succeed");
      oldLimitLength = body.models.length;
    } finally {
      await checkPreviousBound.close();
    }
    return { "adapter-http": {
      schema: "plur1bus.parity-wire/1", transport: "http", exporter: "scripts/parity/export-media-http.ts",
      input: { random: 0.25, submission },
      expected: { success, declined, credential, moderation, waits: sleeper.delays,
        image: Buffer.from(image.bytes).toString("base64") },
      boundaries: { "expected-divergence": "P4D-223", typescriptModelsCharacters: oldLimitLength },
      exchanges: server.calls.map((call, index) => ({
        request: { method: call.method, path: call.path, bodyText: call.body,
          headers: { ...(call.headers["content-type"] ? { "content-type": call.headers["content-type"] } : {}) } },
        response: replies[index],
      })),
    } };
  } finally {
    await server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaHttp });
}
