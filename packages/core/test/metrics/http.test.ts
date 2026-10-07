import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMetricsServer, type MetricsServer } from "../../src/metrics/http.ts";
import { loadOrCreateMetricsToken } from "../../src/metrics/token.ts";
import { createMetrics } from "../../src/metrics/metrics.ts";
import { parseExposition } from "./exposition-parser.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const TOKEN = "t".repeat(48);
const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as any;

function get(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; host?: string } = {}): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path ?? "/metrics", headers: { ...(o.host ? { host: o.host } : {}), ...(o.headers ?? {}) }, timeout: 5000 }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); req.end();
  });
}
const auth = { authorization: `Bearer ${TOKEN}` };

describe("metrics http endpoint", () => {
  let server: MetricsServer; let port = 0; let now = 1_000_000;
  const metrics = createMetrics({ connections: () => 1 });
  metrics.rpcCall("core.status", "ok");
  before(async () => {
    server = createMetricsServer({ token: TOKEN, port: 0, render: () => metrics.render(), logger: log, clock: () => now });
    port = (await server.listen()).port;
  });
  after(async () => { await server.close(); });

  it("serves the exposition for a valid bearer token", async () => {
    const r = await get(port, { headers: auth });
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /^text\/plain; version=0\.0\.4; charset=utf-8$/);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.ok(parseExposition(r.body).length > 0);
  });

  it("answers 401 without or with a wrong token, and never echoes a token", async () => {
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: `Basic ${TOKEN}` }, { authorization: TOKEN }]) {
      const r = await get(port, { headers });
      assert.equal(r.status, 401);
      assert.match(String(r.headers["www-authenticate"]), /^Bearer/);
      assert.equal(r.body.includes(TOKEN), false);
    }
  });

  it("does not accept the token in the query string", async () => {
    const r = await get(port, { path: `/metrics?token=${TOKEN}` });
    assert.equal(r.status, 401);
  });

  it("is read-only: only GET and HEAD, only /metrics", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await get(port, { method, headers: auth });
      assert.equal(r.status, 405); assert.equal(r.headers.allow, "GET, HEAD");
    }
    assert.equal((await get(port, { path: "/", headers: auth })).status, 404);
    assert.equal((await get(port, { path: "/metrics/extra", headers: auth })).status, 404);
    const head = await get(port, { method: "HEAD", headers: auth });
    assert.equal(head.status, 200); assert.equal(head.body, "");
  });

  it("refuses a non-loopback Host header (DNS rebinding)", async () => {
    const r = await get(port, { headers: auth, host: "evil.example" });
    assert.equal(r.status, 403);
    assert.equal((await get(port, { headers: auth, host: `localhost:${port}` })).status, 200);
  });

  it("locks out a client after repeated failures, then recovers (fake clock)", async () => {
    for (let i = 0; i < 10; i++) await get(port, { headers: { authorization: "Bearer bad" } });
    const locked = await get(port, { headers: auth });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers["retry-after"]) > 0);
    now += 120_000;
    assert.equal((await get(port, { headers: auth })).status, 200);
  });

  it("no secret appears in the exposition", async () => {
    const r = await get(port, { headers: auth });
    assert.equal(r.body.includes(TOKEN), false);
    assert.equal(/token|secret|password|bearer|api[_-]?key/i.test(r.body), false);
  });
});

describe("metrics http endpoint: access port", () => {
  it("requires the metrics.read scope from the RBAC port", async () => {
    const calls: string[] = [];
    const s = createMetricsServer({
      token: TOKEN, port: 0, render: () => "# HELP a b\n# TYPE a gauge\na 1\n", logger: log,
      access: { authorize: (tok) => { calls.push(tok); return tok === TOKEN ? { principal: "reader", scopes: ["something.else"] } : null; } },
    });
    const { port } = await s.listen();
    try {
      assert.equal((await get(port, { headers: auth })).status, 403);
      assert.deepEqual(calls, [TOKEN]);
    } finally { await s.close(); }
  });

  it("refuses to bind a non-loopback address", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com"]) {
      assert.throws(() => createMetricsServer({ token: TOKEN, port: 0, host, render: () => "", logger: log }), /loopback/);
    }
  });

  it("refuses a short token", () => {
    assert.throws(() => createMetricsServer({ token: "short", port: 0, render: () => "", logger: log }), /token/);
  });
});

describe("metrics token file", () => {
  it("is created once, random, 0600 on POSIX, and reused", () => {
    const dir = tempDir("p1b-mtok-");
    const f = join(dir, "state", "metrics.token");
    const t1 = loadOrCreateMetricsToken(f);
    assert.match(t1, /^[0-9a-f]{64}$/);
    assert.equal(loadOrCreateMetricsToken(f), t1);
    assert.ok(existsSync(f));
    if (process.platform !== "win32") assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(readFileSync(f, "utf8").trim(), t1);
  });

  it("replaces a file whose token is too short", () => {
    const dir = tempDir("p1b-mtok2-");
    const f = join(dir, "metrics.token");
    writeFileSync(f, "short\n");
    const t = loadOrCreateMetricsToken(f);
    assert.match(t, /^[0-9a-f]{64}$/);
  });
});
