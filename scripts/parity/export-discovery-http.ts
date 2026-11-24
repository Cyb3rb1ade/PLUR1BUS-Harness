import { fileURLToPath } from "node:url";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createPinnedClient, ScanError } from "../../packages/core/src/discovery/http.ts";
import { SCANNERS } from "../../packages/core/src/discovery/scanners/index.ts";
import { fakeHttp, type FakeReply } from "../../packages/core/test/discovery/helpers/fake-http.ts";
import { exporterMain } from "./lib.mjs";

const origin = "https://fixture.invalid";
const agent = "fixture-discovery/1";
const marker = "fixture-discovery-marker";
const json = { data: [{ id: "fixture-model" }] };
const bytes = Buffer.from(JSON.stringify(json));
const response = (status: number, headers = {}, body: unknown = json): FakeReply => ({ status, headers, body });

export async function recordDiscoveryHttp() {
  const cases = [
    { name: "openai", scanner: "openai-models", replies: [response(200)] },
    { name: "anthropic-pages", scanner: "anthropic-models", replies: [
      response(200, {}, { data: [{ id: "first" }], has_more: true, last_id: "model +/&" }),
      response(200, {}, { data: [{ id: "next" }], has_more: false }),
    ] },
    { name: "google-pages", scanner: "google-models", replies: [
      response(200, {}, { models: [{ name: "models/first" }], nextPageToken: "page ?+" }),
      response(200, {}, { models: [{ name: "models/next" }] }),
    ] },
    { name: "ollama", scanner: "ollama-tags", replies: [response(200, {}, { models: [{ name: "fixture" }] })] },
    { name: "same-origin", scanner: "openai-models", replies: [response(302, { location: "/next/models?view=brief" }), response(200)] },
    { name: "foreign-origin", scanner: "openai-models", replies: [response(302, { location: "https://catalog.example.invalid/models" })] },
    { name: "paging-boundary", scanner: "anthropic-models", replies: Array.from({ length: 10 }, (_, page) =>
      response(200, {}, { data: [], has_more: true, last_id: `fixture-${page}` })) },
    { name: "relative", scanner: "openai-models", replies: [response(307, { location: "next" }), response(200)] },
    { name: "redirect-limit", scanner: "openai-models", replies: [1, 2, 3, 4].map(n => response(302, { location: `/next${n}` })) },
    { name: "missing-location", scanner: "openai-models", replies: [response(302)] },
    { name: "text-response", scanner: "openai-models", replies: [response(200, { "content-type": "text/plain" })] },
    { name: "structured-suffix", scanner: "openai-models", replies: [response(200, { "content-type": "Application/vnd.fixture+JSON; charset=utf-8" })] },
    { name: "auth", scanner: "openai-models", replies: [response(403)] },
    { name: "rate-limit", scanner: "openai-models", replies: [response(429, { "retry-after": "7" })] },
    { name: "upstream-error", scanner: "openai-models", replies: [response(502)] },
    { name: "missing-route", scanner: "openai-models", replies: [response(404)] },
    { name: "unknown-encoding", scanner: "openai-models", replies: [response(200, { "content-encoding": "fixture-codec" })] },
    ...([["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const).flatMap(([encoding, compress]) =>
      [true, false].map(valid => ({ name: `${encoding}-${valid ? "good" : "invalid"}`, scanner: "openai-models",
        replies: [{ ...response(200, { "content-encoding": encoding }), raw: valid ? compress(bytes) : Buffer.from("invalid") }] }))),
    { name: "invalid-json", scanner: "openai-models", replies: [{ ...response(200), raw: Buffer.from("{") }] },
  ] as const;
  const vectors = [];
  for (const item of cases) {
    let offset = 0;
    const fake = fakeHttp(() => {
      const reply = item.replies[offset++];
      if (!reply) throw new Error("missing synthetic reply");
      return reply;
    });
    const headerName = item.scanner === "anthropic-models" ? "x-api-key" : item.scanner === "google-models" ? "x-goog-api-key" : "authorization";
    const lease = item.scanner === "ollama-tags" ? null : { origin, headerName, headerValue: marker };
    const client = createPinnedClient({ baseUrl: `${origin}/v1`, lease, userAgent: agent, request: fake.request });
    let expected;
    try {
      expected = await SCANNERS[item.scanner as keyof typeof SCANNERS]({ id: "fixture" } as never, client);
    } catch (error) {
      if (!(error instanceof ScanError)) throw error;
      const { result, reason, httpStatus, retryAfterMs } = error;
      expected = { result, reason, httpStatus, retryAfterMs };
    }
    const exchanges = fake.calls.map(({ url, headers }, i) => {
      const { pathname, search } = new URL(url);
      const { status, headers: replyHeaders, body, raw } = item.replies[i] as FakeReply;
      return {
        request: { method: "GET", path: pathname + search, headers: Object.fromEntries(Object.entries(headers).map(([name, value]) =>
          [name.toLowerCase(), value === marker ? "<credential>" : value])) },
        response: { status, headers: { "content-type": "application/json", ...replyHeaders },
          ...(raw ? { chunksBase64: [raw.toString("base64")] } : { body }) },
      };
    });
    vectors.push({ name: item.name, scanner: item.scanner, headerName: lease?.headerName, transport: "http", exchanges, expected });
  }
  return { http: { source: "packages/core/src/discovery/http.ts", cases: vectors } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "discovery", build: recordDiscoveryHttp });
}
