import { fileURLToPath } from "node:url";
import { HttpImageAdapter } from "../../packages/media/src/adapters.ts";
import { ModelCatalog } from "../../packages/media/src/adapters/openrouter-models.ts";
import { probeDrawThings } from "../../packages/media/src/adapters/drawthings-probe.ts";
import { fakeServer, json } from "../../packages/media/test/adapters-fixtures.ts";
import { exporterMain } from "./lib.mjs";

export async function recordMediaDiscovery() {
  const doc = { data: [
    { id: "sample/text", architecture: { output_modalities: ["text"] } },
    { id: "sample/image", name: "Fixture", architecture: { output_modalities: ["image"], input_modalities: ["text", "image"] } },
    { id: "sample/fresh", architecture: { output_modalities: ["image"] } },
  ] };
  const server = await fakeServer((_call, reply) => json(reply, 200, doc));
  try {
    const signal = AbortSignal.timeout(2000);
    const adapter = new HttpImageAdapter({ id: "openrouter", model: "sample/image", baseUrl: server.url });
    const models = await adapter.listModels(signal);
    const running = await probeDrawThings(server.url);
    const unavailable: typeof fetch = async () => { throw new Error("simulated local service unavailable"); };
    const apiOff = await probeDrawThings(server.url, { fetch: unavailable, platform: "darwin", appInstalled: () => true });
    const notInstalled = await probeDrawThings(server.url, { fetch: unavailable, platform: "darwin", appInstalled: () => false });
    let now = 1000;
    let reads = 0;
    const catalog = new ModelCatalog(async () => {
      reads++;
      if (reads === 2) throw new Error("offline fixture");
      return reads === 1 ? doc : { data: doc.data.slice(-1) };
    }, { now: () => now, ttlMs: 100, failureBackoffMs: 50 });
    const snapshots = [];
    for (const time of [1000, 1050, 1100, 1149, 1150]) {
      now = time;
      snapshots.push({ now, reads, models: await catalog.list(signal) });
    }
    return { "media-discovery": {
      schema: "plur1bus.parity-wire/1", transport: "http",
      expected: { models, running, apiOff, notInstalled, snapshots, reads },
      input: { ttl: 100, backoff: 50, first: doc, last: { data: doc.data.slice(-1) } },
      exchanges: server.calls.map((request) => ({
        request: { method: request.method, path: request.path, bodyText: request.body },
        response: { status: 200, body: doc },
      })),
    } };
  } finally {
    await server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaDiscovery });
}
