import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createWebFetch, DocStore, type WebFetchArgs } from "../../packages/core/src/tools/web/fetch.ts";
import { HostPacer } from "../../packages/core/src/tools/web/robots.ts";
import { WebFailure } from "../../packages/core/src/tools/web/failure.ts";
import { exporterMain } from "./lib.mjs";

const NOW = Date.parse("2026-11-23T10:00:00Z");
const agent = "fixture-web-fetch/1";
const html = '<main><header><h1>Edition</h1></header><p>Read <a href="/notes">the notes</a>.</p><h2>Local</h2><p>The town hall has opened.</p></main>';
const long = Array.from({ length: 18 }, (_, i) => `Section ${i + 1} has a readable sentence and a short detail. 🌙`).join("\n\n");
type Reply = { status: number; body: string; headers?: Record<string, string> };
type Action = Omit<WebFetchArgs, "url"> & { path?: string; agent?: string; resume?: boolean };
const htmlReply: Reply = { status: 200, body: html, headers: { "content-type": "text/html" } };
const robots: Reply = { status: 200, body: "User-agent: *\nDisallow: /draft\n", headers: { "content-type": "text/plain" } };

class FixtureStore extends DocStore {
  private fixture?: { agent: string; entry: Parameters<DocStore["put"]>[1] };
  override put(agent: string, entry: Parameters<DocStore["put"]>[1]): string {
    this.fixture = { agent, entry };
    return "010203040506";
  }
  override get(agent: string, id: string): ReturnType<DocStore["get"]> {
    return id === "010203040506" && this.fixture?.agent === agent ? this.fixture.entry : undefined;
  }
}

export async function recordWebFetch() {
  const cases: { name: string; actions: Action[]; replies: Record<string, Reply> }[] = [
    { name: "section-and-links", actions: [{ section: "Local" }], replies: { "/page": htmlReply } },
    { name: "guarded-json-order", actions: [{}], replies: {
      "/page": { status: 200, body: '{"z":1.0,"2":"b","1":"a","z":4,"nested":{"second":false,"first":null}}', headers: { "content-type": "application/json; charset=utf-8" } },
    } },
    { name: "raw-html", actions: [{ mode: "raw" }], replies: { "/page": htmlReply } },
    { name: "html-from-generic-type", actions: [{}], replies: {
      "/page": { status: 200, body: `<!DOCTYPE html><html>${html}</html>`, headers: { "content-type": "application/octet-stream" } },
    } },
    { name: "rate-limit", actions: [{}], replies: {
      "/page": { status: 429, body: "Please try again later.", headers: { "retry-after": "7", "content-type": "text/plain" } },
    } },
    { name: "agent-bound-cursor-no-second-request", actions: [{ maxTokens: 100 }, { maxTokens: 100, resume: true, agent: "reader-b" }, { maxTokens: 100, resume: true }], replies: {
      "/page": { status: 200, body: long, headers: { "content-type": "text/plain" } },
    } },
    { name: "crawl-cache-and-redirect", actions: [{ crawl: true }, { crawl: true, path: "/edition" }, { crawl: true, path: "/draft" }], replies: {
      "/robots.txt": robots,
      "/page": { status: 302, body: "", headers: { location: "/edition" } },
      "/edition": htmlReply,
    } },
    { name: "crawl-refusal-after-a-regular-redirect", actions: [{ crawl: true }], replies: {
      "/robots.txt": robots, "/page": { status: 302, body: "", headers: { location: "/draft" } },
    } },
    { name: "missing-robots", actions: [{ crawl: true }], replies: {
      "/robots.txt": { status: 404, body: "Not found" }, "/page": htmlReply,
    } },
    { name: "temporarily-unavailable-robots", actions: [{ crawl: true }], replies: {
      "/robots.txt": { status: 503, body: "Please try again later." },
    } },
  ];
  const vectors = [];
  for (const row of cases) {
    const wire: unknown[] = [];
    const server = createServer((request, response) => {
      const reply = row.replies[request.url ?? ""];
      if (!reply) { response.writeHead(404).end(); return; }
      wire.push({
        request: { method: request.method, path: request.url },
        response: { status: reply.status, headers: reply.headers,
          chunksBase64: reply.body ? [Buffer.from(reply.body).toString("base64")] : [] },
      });
      response.writeHead(reply.status, { "content-length": Buffer.byteLength(reply.body), ...reply.headers }).end(reply.body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a loopback HTTP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const fetch = createWebFetch({ userAgent: agent, allowPrivate: ["127.0.0.0/8"], now: () => NOW,
      store: new FixtureStore({ now: () => NOW }),
      pacer: new HostPacer({ minIntervalMs: 0, now: () => NOW, sleep: async () => {} }),
    });
    let remembered: string | undefined;
    const steps = [];
    for (const action of row.actions) {
      const { path = "/page", agent: agentId = "reader-a", resume, ...rest } = action;
      const options = { ...rest, ...(resume && remembered ? { cursor: remembered } : {}) };
      let expected;
      try {
        const result = await fetch.fetch({ url: origin + path, ...options }, { agentId });
        remembered = result.cursor ?? remembered;
        expected = JSON.parse(JSON.stringify(result).replaceAll(origin, "<origin>"));
      } catch (error) {
        if (!(error instanceof WebFailure)) throw error;
        expected = { code: error.code, status: error.extra.status, retryAfterSeconds: error.extra.retryAfterSeconds };
      }
      steps.push({ path, agentId, options, expected });
    }
    server.close();
    await once(server, "close");
    vectors.push({ name: row.name, transport: "http", exchanges: wire, steps });
  }
  return { fetch: { source: "packages/core/src/tools/web/fetch.ts", agent, nowMs: NOW, cases: vectors } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "web", build: recordWebFetch });
}
