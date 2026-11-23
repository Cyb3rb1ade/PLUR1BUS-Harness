import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createWebSearch, type WebSearchArgs } from "../../packages/core/src/tools/web/search.ts";
import { createKeyedProvider, createRateLimiter, type KeyedProviderId } from "../../packages/core/src/tools/web/search-providers.ts";
import { createSearxngProvider } from "../../packages/core/src/tools/web/searxng.ts";
import { createSearchApiClient } from "../../packages/core/src/tools/web/search-http.ts";
import { WebFailure } from "../../packages/core/src/tools/web/failure.ts";
import { exporterMain } from "./lib.mjs";

const START = Date.parse("2026-11-23T10:00:00Z");
const agent = "fixture-web-search/1";
const marker = "fixture-web-provider-credential";
const title = "<b>Town hall</b> &amp; Notes";
const url = "https://news.fixture.invalid/edition#local";
type Vendor = KeyedProviderId | "searxng";
type Reply = { status: number; headers?: Record<string, string>; doc?: unknown; raw?: string };
const ok = (doc: unknown): Reply => ({ status: 200, doc });
const none = { status: 503, doc: { reason: marker } };
const brave = ok({ web: { results: [
  { title, url, description: "One &lt;i&gt;edition&lt;/i&gt;", page_age: "2026-11-20T00:00:00" },
  { title: "Duplicate", url: url.split("#")[0] },
  { title: "Other source", url: "https://other.fixture.invalid/article" },
] } });
const tavily = ok({ results: [{ title, url, content: "Brief notes", published_date: "2026-11-20" }] });
const exa = ok({ results: [{ title, url, highlights: ["First note", "Second note"], publishedDate: "2026-11-21T10:20:00" }] });
const searxng = ok({ results: [{ title, url, content: "Syndicated note", publishedDate: "2026-11-22T19:00:00Z" }] });
const query: WebSearchArgs = { query: "  café & reports  ", count: 4, site: "NEWS.fixture.invalid", freshness: "week", lang: "de-CH" };

function errorResult(error?: WebFailure) {
  return error ? { code: error.code, status: error.extra.status, retryAfterSeconds: error.extra.retryAfterSeconds } : null;
}

export async function recordWebSearch() {
  const cases: { name: string; vendors: Vendor[]; replies: Reply[]; repeat?: number; missingKey?: boolean }[] = [
    { name: "brave-normalization", vendors: ["brave"], replies: [brave] },
    { name: "tavily-json", vendors: ["tavily"], replies: [tavily] },
    { name: "exa-json", vendors: ["exa"], replies: [exa] },
    { name: "searxng-path", vendors: ["searxng"], replies: [searxng] },
    { name: "fallback-to-next-provider", vendors: ["tavily", "exa"], replies: [none, exa] },
    { name: "short-rate-limit-retry", vendors: ["brave"], replies: [{ status: 429, headers: { "retry-after": "1" } }, brave] },
    { name: "persistent-rate-limit", vendors: ["brave"], replies: [{ status: 429, headers: { "retry-after": "60" }, doc: { reason: marker } }], repeat: 2 },
    { name: "missing-key", vendors: ["tavily"], replies: [], missingKey: true },
    { name: "redirect-refusal", vendors: ["exa"], replies: [{ status: 302, headers: { location: "/after" } }] },
    { name: "invalid-provider-json", vendors: ["brave"], replies: [{ status: 200, raw: "{" }] },
  ];
  const vectors = [];
  for (const row of cases) {
    const requests: unknown[] = [];
    const outcomes: unknown[] = [];
    const traces: unknown[] = [];
    const sleeps: number[] = [];
    let now = START;
    const server = createServer(async (request, response) => {
      const reply = row.replies[requests.length];
      if (!reply) { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const headers = Object.fromEntries(["accept", "accept-encoding", "authorization", "content-type", "content-length", "connection", "user-agent", "x-api-key", "x-subscription-token"]
        .filter(name => request.headers[name] !== undefined)
        .map(name => [name, String(request.headers[name]).replaceAll(marker, "<credential>")]));
      const body = reply.raw ?? (reply.doc === undefined ? "" : JSON.stringify(reply.doc));
      requests.push({
        request: { method: request.method, path: request.url, headers, bodyBase64: Buffer.concat(chunks).toString("base64") },
        response: { status: reply.status, headers: { "content-type": "application/json", ...reply.headers },
          chunksBase64: body ? [Buffer.from(body).toString("base64")] : [] },
      });
      response.writeHead(reply.status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...reply.headers }).end(body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a loopback HTTP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const api = createSearchApiClient({ userAgent: agent, egress: () => ({
      allowHosts: ["127.0.0.1"], allowPorts: [address.port], allowLoopback: true,
    }) });
    const report = (vendor: Vendor) => (failure: WebFailure | undefined) => outcomes.push({ vendor, failure: errorResult(failure) });
    const providers = row.vendors.map(vendor => vendor === "searxng" ? createSearxngProvider({
      baseUrl: new URL(`${origin}/searxng`), onOutcome: report(vendor),
      request: (url, opts) => api({ method: "GET", url, headers: { accept: "application/json" } }, opts),
    }) : createKeyedProvider(vendor, {
      endpoint: `${origin}/${vendor}`,
      apiKey: async () => row.missingKey ? null : marker,
      limiter: createRateLimiter({ now: () => now }),
      onOutcome: report(vendor),
      request: api,
      now: () => now,
      sleep: async ms => { sleeps.push(ms); now += ms; },
    }));
    const search = createWebSearch({ providers, now: () => now, trace: (trace) => traces.push(trace) });
    const steps = [];
    for (let i = 0; i < (row.repeat ?? 1); i++) {
      try { steps.push(await search.search(query)); }
      catch (error) {
        if (!(error instanceof WebFailure)) throw error;
        steps.push({ code: error.code });
      }
    }
    server.close();
    await once(server, "close");
    // Keep even error response bodies synthetic and avoid storing the actual header marker.
    const exchanges = requests.map(item => {
      const exchange = item as { response: { chunksBase64: string[] } };
      exchange.response.chunksBase64 = exchange.response.chunksBase64.map(chunk =>
        Buffer.from(Buffer.from(chunk, "base64").toString().replaceAll(marker, "<credential>")).toString("base64"));
      return exchange;
    });
    vectors.push({ name: row.name, transport: "http", vendors: row.vendors, missingKey: row.missingKey, exchanges, steps, outcomes, traces, sleeps });
  }
  return { search: { source: "packages/core/src/tools/web/search.ts", agent, nowMs: START, query, cases: vectors } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "web", build: recordWebSearch });
}
