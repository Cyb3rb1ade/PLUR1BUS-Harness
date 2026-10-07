import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
  const http = createOAuthHttp({ egress, timeoutMs: 100, maxBytes: 1024 });
  for (const path of ["redirect", "large", "bad", "hang"]) await assert.rejects(http.post(`http://127.0.0.1:${port}/${path}`, { client_secret: MARK.key }), e => !inspect(e).includes(MARK.access));
  assert.equal(hits, 4);
  const data = await http.post(`http://127.0.0.1:${port}/token`, {});
  assert.equal(data.access_token, MARK.access); assert.ok(!inspect(data).includes(MARK.access)); assert.ok(!JSON.stringify(data).includes(MARK.access));
});
it("a hanging egress decision has a bounded deadline and never sends the form", async () => {
  const http = createOAuthHttp({ egress: { decide: () => new Promise(() => {}) }, timeoutMs: 30 });
  const keepAlive = setTimeout(() => {}, 200);
  try { await assert.rejects(http.post("https://example.test/token", { client_secret: MARK.key }), (e: any) => e.retryable && !inspect(e).includes(MARK.key)); }
  finally { clearTimeout(keepAlive); }
});
