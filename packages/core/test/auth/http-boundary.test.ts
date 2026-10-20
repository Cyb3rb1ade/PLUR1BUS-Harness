import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { createOAuthHttp } from "../../src/auth/http.ts";
import { createEgress } from "../../src/egress/service.ts";
import { MARK } from "./helpers.ts";
import { inspect } from "node:util";
it("token POST never follows redirects, caps bytes, times out and redacts malformed replies", async t => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/redirect") { res.writeHead(307, { location: "/target" }); res.end(); }
    else if (req.url === "/large") res.end("X".repeat(2048));
    else if (req.url === "/bad") res.end(MARK.access);
    else if (req.url === "/hang") { /* deadline must close it */ }
    else res.end(JSON.stringify({ access_token: MARK.access, token_type: "Bearer", expires_in: 3600 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const egress = createEgress({ config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [port], allowLoopback: true }) });
  const http = createOAuthHttp({ egress, timeoutMs: 1000, maxBytes: 1024 });
  for (const path of ["redirect", "large", "bad", "hang"]) await assert.rejects((path === "hang" ? createOAuthHttp({ egress, timeoutMs: 50 }) : http).post(`http://127.0.0.1:${port}/${path}`, { client_secret: MARK.key }), e => !inspect(e).includes(MARK.access));
  assert.equal(hits, 4);
  const data = await http.post(`http://127.0.0.1:${port}/token`, {});
  assert.equal(data.access_token, MARK.access); assert.ok(!inspect(data).includes(MARK.access)); assert.ok(!JSON.stringify(data).includes(MARK.access));
});
it("a hanging egress request has a bounded deadline and never leaks the form", async () => {
  const http = createOAuthHttp({ egress: { request: () => new Promise(() => {}) }, timeoutMs: 30 });
  const keepAlive = setTimeout(() => {}, 200);
  try { await assert.rejects(http.post("https://example.test/token", { client_secret: MARK.key }), (e: any) => e.retryable && !inspect(e).includes(MARK.key)); }
  finally { clearTimeout(keepAlive); }
});
it("the token POST obeys the egress policy: an unlisted host, a private resolution, plain http to a public name and URL credentials are refused before anything is sent", async t => {
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.end("{}"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const code = (c: string) => (e: any) => e.code === c && !e.retryable && !inspect(e).includes(MARK.key);
  const form = { client_secret: MARK.key };
  await assert.rejects(createOAuthHttp({ egress: createEgress({ config: () => ({ allowHosts: [], allowPorts: [port], allowLoopback: true }) }) }).post(`http://127.0.0.1:${port}/token`, form), code("egress_denied"));
  const open = createEgress({ config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [port], allowLoopback: true }) });
  await assert.rejects(createOAuthHttp({ egress: open }).post(`http://user:pw@127.0.0.1:${port}/token`, form), code("egress_denied"));
  await assert.rejects(createOAuthHttp({ egress: open }).post(`ftp://127.0.0.1:${port}/token`, form), code("egress_denied"));
  const resolver = async (host: string) => host === "idp.test" ? [{ address: "10.0.0.7", family: 4 as const }] : [{ address: "93.184.216.34", family: 4 as const }];
  const pub = createEgress({ config: () => ({ allowHosts: ["idp.test", "plain.test"], allowPorts: [80, 443], allowLoopback: false }), resolver });
  await assert.rejects(createOAuthHttp({ egress: pub }).post("https://idp.test/token", form), code("egress_denied"));
  await assert.rejects(createOAuthHttp({ egress: pub }).post("http://plain.test/token", form), code("egress_denied"));
  assert.equal(hits, 0);
});
it("the token POST sends a form with a content length, JSON accept and the auth user agent, and decodes a compressed answer", async t => {
  const seen: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c as Buffer));
    req.on("end", () => {
      seen.push({ ...req.headers, body: Buffer.concat(chunks).toString("utf8"), method: req.method });
      const body = gzipSync(JSON.stringify({ access_token: MARK.access, token_type: "Bearer" }));
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }); res.end(body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const egress = createEgress({ config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [port], allowLoopback: true }) });
  const data = await createOAuthHttp({ egress }).post(`http://127.0.0.1:${port}/token`, { grant_type: "refresh_token", refresh_token: "r 1&2" });
  assert.equal(data.access_token, MARK.access);
  const r = seen[0]!;
  assert.equal(r.method, "POST"); assert.equal(r.body, "grant_type=refresh_token&refresh_token=r+1%262");
  assert.equal(r["content-type"], "application/x-www-form-urlencoded"); assert.equal(r.accept, "application/json");
  assert.equal(r["content-length"], String(Buffer.byteLength(r.body as string))); assert.equal(r["user-agent"], "PLUR1BUS-auth");
  assert.ok(!("cookie" in r) && !("authorization" in r));
});
