import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { guardedRequest, type HttpOptions } from "../../packages/core/src/tools/web/http.ts";
import { makeAddressPolicy } from "../../packages/core/src/tools/web/guard.ts";
import { WebFailure } from "../../packages/core/src/tools/web/failure.ts";
import { exporterMain } from "./lib.mjs";

const agent = "fixture-web-tools/1";
const accept = "text/plain,application/json";
const marker = "fixture-web-request-marker";
const plain = Buffer.from("a normal fixture page");
type Reply = { status: number; headers?: Record<string, string>; bytes?: Buffer };
type Options = Pick<HttpOptions, "method" | "headers" | "redirect" | "maxRedirects" | "maxBytes" | "errorBodyBytes" | "discardBody"> & { body?: string };
const ok = (bytes = plain, headers = {}): Reply => ({ status: 200, headers: { "content-type": "text/plain", ...headers }, bytes });
const hop = { status: 302, headers: { location: "/archive?view=short" }, bytes: Buffer.from("redirect body") };

export async function recordWebHttp() {
  const cases: { name: string; options?: Options; replies: Reply[] }[] = [
    { name: "plain", replies: [ok()] },
    { name: "relative-redirect", replies: [hop, ok()] },
    { name: "one-redirect-limit", options: { maxRedirects: 1 }, replies: [hop, hop] },
    { name: "manual-redirect", options: { redirect: "manual" }, replies: [hop] },
    { name: "refuse-redirect", options: { redirect: "error" }, replies: [hop] },
    { name: "submitted-form", options: {
      method: "POST", headers: { authorization: marker, "content-type": "text/plain" }, body: "answer=blue",
    }, replies: [hop] },
    { name: "diagnostic-prefix", options: { errorBodyBytes: 5 }, replies: [{ status: 429, bytes: plain }] },
    { name: "invalid-diagnostic-encoding", options: { errorBodyBytes: 8 },
      replies: [{ status: 503, headers: { "content-encoding": "gzip" }, bytes: plain }] },
    { name: "stream-decoding", replies: [ok(gzipSync(plain), { "content-encoding": "gzip" })] },
    { name: "encoding-order", replies: [ok(brotliCompressSync(gzipSync(plain)), { "content-encoding": "gzip, br" })] },
    { name: "decoded-cap", options: { maxBytes: 5 }, replies: [ok(gzipSync(plain), { "content-encoding": "gzip" })] },
    { name: "declared-cap", options: { maxBytes: 5 }, replies: [ok()] },
    { name: "status-only", options: { discardBody: true }, replies: [ok()] },
    { name: "head", options: { method: "HEAD" }, replies: [ok()] },
  ];
  const vectors = [];
  for (const entry of cases) {
    const wire: unknown[] = [];
    const server = createServer(async (request: IncomingMessage, response) => {
      const reply = entry.replies[wire.length];
      if (!reply) { response.writeHead(404).end(); return; }
      const buffers: Buffer[] = [];
      for await (const buffer of request) buffers.push(buffer as Buffer);
      const headers = Object.fromEntries(["accept", "accept-encoding", "authorization", "content-type", "content-length", "connection", "user-agent"]
        .filter(name => request.headers[name] !== undefined)
        .map(name => [name, request.headers[name] === marker ? "<credential>" : request.headers[name]]));
      wire.push({
        request: { method: request.method, path: request.url, headers, bodyBase64: Buffer.concat(buffers).toString("base64") },
        response: { status: reply.status, headers: reply.headers,
          chunksBase64: reply.bytes ? [reply.bytes.toString("base64")] : [] },
      });
      response.writeHead(reply.status, { "content-length": reply.bytes?.length ?? 0, ...reply.headers }).end(reply.bytes);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a loopback HTTP address");
    const path = (url: string) => { const uri = new URL(url); return uri.pathname + uri.search; };
    let expected;
    try {
      const result = await guardedRequest(`http://127.0.0.1:${address.port}/current`, {
        ...entry.options, userAgent: agent, accept, policy: makeAddressPolicy(["127.0.0.0/8"]),
      });
      expected = { status: result.status, path: path(result.url), redirects: result.redirects.map(path), bodyBase64: result.body.toString("base64") };
    } catch (error) {
      if (!(error instanceof WebFailure)) throw error;
      expected = { code: error.code };
    } finally {
      server.close();
      await once(server, "close");
    }
    const options = entry.options?.headers ? {
      ...entry.options, headers: { ...entry.options.headers, authorization: "<credential>" },
    } : entry.options;
    vectors.push({ name: entry.name, transport: "http", options, requestPath: "/current", exchanges: wire, expected });
  }
  return { http: { source: "packages/core/src/tools/web/http.ts", agent, accept, cases: vectors } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "web", build: recordWebHttp });
}
