// W1 AF1 exchanges recorded through the real TypeScript Unix transport and the existing synthetic fm server.
import { probeEndpoint } from "../../packages/providers/src/local/probe.ts";
import type { LocalDialect } from "../../packages/providers/src/local/types.ts";
import { startStub } from "../../packages/providers/test/helpers/stub.ts";
import { fileURLToPath } from "node:url";
import { createChatCompletionsAdapter, createLocalChatAdapter, createUnixFetch, type ChatRequest } from "../../packages/providers/src/index.ts";
import { APPLE_FM_BASE_URL } from "../../packages/providers/src/local/unix.ts";
import { startFakeFmServe } from "../../packages/providers/test/fixtures/fake-fm-serve.ts";
import { exporterMain } from "./lib.mjs";

const request: ChatRequest = { model: "system", maxTokens: 128, messages: [{ role: "user", content: "Hello." }] };
const bodies: Record<string, unknown> = {
  "/health": { status: "fm serve is running", models: [{ name: "system", available: true }] },
  "/v1/models": { object: "list", data: [{ id: "system", owned_by: "Apple" }] },
  "/v1/chat/completions": {
    id: "fixture-fm", model: "system",
    choices: [{ index: 0, message: { role: "assistant", content: "Hallo." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  },
};

export async function buildLocalProviderFixtures() {
  const fm = await startFakeFmServe({
    handler: (recorded, res) => {
      const body = bodies[recorded.path ?? ""];
      if (body === undefined) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    },
  });
  try {
    const unix = { socket: fm.socket, guard: { verify: () => ({ ok: true as const }) } };
    const raw = createUnixFetch(fm.socket, unix);
    const origin = new URL(APPLE_FM_BASE_URL).origin;
    const health = await (await raw(`${origin}/health`, { headers: { accept: "application/json" } })).json();
    const models = await (await raw(`${origin}/v1/models`, { headers: { accept: "application/json" } })).json();
    const adapter = createLocalChatAdapter({ state: "ok", baseUrl: APPLE_FM_BASE_URL, socket: "managed:apple-fm" }, createChatCompletionsAdapter, undefined, { unix });
    const result = await adapter.complete(request);
    const outcomes = [health, models, result];
    if (fm.requests.length !== outcomes.length || result.text !== "Hallo.") throw new Error("incomplete AF1 recording");
    const exchanges = fm.requests.map((seen, i) => {
      if (!seen.path || seen.headers.authorization !== undefined) throw new Error("invalid AF1 request record");
      return {
        name: seen.path, request: { method: seen.method, path: seen.path, bodyText: seen.body, host: seen.headers.host, accept: seen.headers.accept },
        response: { status: 200, body: bodies[seen.path] },
        expected: outcomes[i],
      };
    });
    return { "apple-fm": { schema: "plur1bus.parity-wire/1", source: "packages/providers/src/local/unix.ts",
      exporter: "scripts/parity/export-provider-local.ts", transport: "http", requestJson: JSON.stringify(request), exchanges } };
  } finally {
    await fm.close();
  }
}

export async function buildLocalProbeFixtures() {
  type Reply = { status: number; body: unknown; headers?: Record<string, string> };
  type Scenario = { name: string; dialects: LocalDialect[]; replies: Record<string, Reply> };
  const scenarios: Scenario[] = [
    {
      name: "ollama-list", dialects: ["ollama", "openai"],
      replies: { "/api/tags": { status: 200, body: { models: [{ name: "small" }, { name: "small" }, { name: "large" }, { name: "" }] } } },
    },
    {
      name: "empty-to-openai", dialects: ["ollama", "openai"],
      replies: {
        "/api/tags": { status: 200, body: { models: [] } },
        "/v1/models": { status: 200, body: { data: [{ id: "chat" }] } },
      },
    },
    {
      name: "redirect", dialects: ["openai"],
      replies: { "/v1/models": { status: 302, headers: { location: "/never" }, body: null } },
    },
    {
      name: "invalid-model-entries", dialects: ["openai"],
      replies: { "/v1/models": { status: 200, body: { data: [null, { id: "x".repeat(257) }] } } },
    },
  ];
  const cases = [];
  for (const { name, dialects, replies } of scenarios) {
    const stub = await startStub((_request, res, recorded) => {
      const response = replies[recorded.url ?? ""];
      res.writeHead(response?.status ?? 404, { "content-type": "application/json", ...response?.headers });
      res.end(JSON.stringify(response?.body ?? null));
    });
    try {
      const origin = new URL(stub.baseUrl).origin;
      const expected = await probeEndpoint({ origin, dialects });
      const exchanges = stub.requests.map((seen) => {
        const reply = replies[seen.url ?? ""];
        if (!reply || seen.headers.authorization !== undefined) throw new Error("invalid local probe request record");
        return { request: { method: seen.method, path: seen.url, bodyText: seen.body, accept: seen.headers.accept }, response: reply };
      });
      cases.push({ name, dialects, exchanges, expected: { ...expected, baseUrl: expected.baseUrl.replace(origin, "@origin@") } });
    } finally {
      await stub.close();
    }
  }
  return { "http-probe": { schema: "plur1bus.parity-wire/1", source: "packages/providers/src/local/probe.ts",
    exporter: "scripts/parity/export-provider-local.ts", transport: "http", cases } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({
    area: "provider-local",
    build: async () => ({
      ...await buildLocalProbeFixtures(),
      ...(process.platform === "win32" ? {} : await buildLocalProviderFixtures()),
    }),
  }));
}
