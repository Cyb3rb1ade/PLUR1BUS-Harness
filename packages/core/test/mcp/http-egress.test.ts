import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createEgress } from "../../src/egress/index.ts";
import { createMcpFetch } from "../../src/mcp/http.ts";

it("HTTP pins egress decisions and supports POST/SSE without external networking", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.method!);
    if (req.method === "GET") res.writeHead(200, { "content-type": "text/event-stream" }).end('id: test\ndata: {}\n\n');
    else res.writeHead(200, { "content-type": "application/json" }).end('{}');
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  let resolutions = 0;
  const egress = createEgress({ config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [port], allowLoopback: true }),
    resolver: async () => { resolutions++; return [{ address: "127.0.0.1", family: 4 }]; } });
  const fetch = createMcpFetch({ egress });
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" })).text(), "{}");
    assert.match(await (await fetch(`http://127.0.0.1:${port}/mcp`)).text(), /id: test/);
    await assert.rejects(fetch("https://not-allowed.invalid/"), /egress/);
    assert.deepEqual(requests, ["POST", "GET"]);
    assert.equal(egress.status().decisions.allowed, 2);
    assert.ok(resolutions <= 2);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
it("HTTP refuses credentials, redirects never follow implicitly, and body limits are enforced", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") res.writeHead(302, { location: "https://blocked.invalid/" }).end();
    else res.writeHead(200, { "content-type": "application/json" }).end("x".repeat(1025));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const egress = createEgress({ config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [port], allowLoopback: true }) });
  const fetch = createMcpFetch({ egress, maxFrameBytes: 1024 });
  try {
    await assert.rejects(fetch(`http://name:fake-token@127.0.0.1:${port}/`), /credentials/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/redirect`)).status, 302);
    await assert.rejects((await fetch(`http://127.0.0.1:${port}/large`)).text(), /limit/);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
