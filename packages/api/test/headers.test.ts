import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { CSP, securityHeaders } from "../src/headers.ts";
import { jsonHeaders, login, OWNER_TOKEN, raw, start, type Res } from "./helpers.ts";

function expectSecurityHeaders(h: Record<string, string | string[] | undefined>, label: string): void {
  const want = securityHeaders(false);
  for (const [k, v] of Object.entries(want)) assert.equal(h[k.toLowerCase()], v, `${label}: ${k}`);
  assert.equal(h["content-security-policy"], CSP, label);
  assert.equal(h["strict-transport-security"], undefined, `${label}: no HSTS over plain HTTP`);
}

test("the CSP and the other security headers are on every response, success and error alike", async () => {
  const h = await start({ limits: { maxBodyBytes: 256 }, rateClasses: { auth: { capacity: 100, refillPerSec: 1 }, read: { capacity: 4, refillPerSec: 0.001 }, write: { capacity: 100, refillPerSec: 1 } } });
  try {
    const { cookie } = await login(h);
    const cases: Array<[string, Promise<Res>]> = [
      ["200 whoami", raw(h, { path: "/api/v1/whoami", headers: { cookie } })],
      ["200 health", raw(h, { path: "/api/v1/health", headers: { cookie } })],
      ["401", raw(h, { path: "/api/v1/agents" })],
      ["403 csrf", raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie } })],
      ["404", raw(h, { path: "/api/v1/nope" })],
      ["404 root", raw(h, { path: "/" })],
      ["405", raw(h, { method: "PUT", path: "/api/v1/whoami", headers: { cookie } })],
      ["405 OPTIONS", raw(h, { method: "OPTIONS", path: "/api/v1/whoami", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } })],
      ["400 bad json", raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: "{" })],
      ["413", raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: "x".repeat(1024) })],
      ["421", raw(h, { path: "/api/v1/health", headers: { host: "evil.example" } })],
    ];
    for (const [label, p] of cases) { const r = await p; expectSecurityHeaders(r.headers, label); assert.match(String(r.headers["content-type"]), /^application\/json/, label); }
    // The 5th read-class request from this IP trips the limiter (4 above plus whoami/health/...): 429 has the headers too.
    let limited: Res | undefined;
    for (let i = 0; i < 6 && !limited; i++) { const r = await raw(h, { path: "/api/v1/whoami", headers: { cookie } }); if (r.status === 429) limited = r; }
    assert.ok(limited, "a 429 was produced"); expectSecurityHeaders(limited.headers, "429");
  } finally { await h.close(); }
});

test("no response sets CORS headers, so a browser page of another origin can read nothing", async () => {
  const h = await start();
  try {
    const { cookie, res } = await login(h);
    for (const r of [res, await raw(h, { path: "/api/v1/whoami", headers: { cookie } }), await raw(h, { path: "/api/v1/whoami" })]) {
      assert.equal(r.headers["access-control-allow-origin"], undefined); assert.equal(r.headers["access-control-allow-credentials"], undefined);
    }
  } finally { await h.close(); }
});

test("requests Node rejects before routing (garbage, oversized headers) get the headers and an error/1 body", async () => {
  const h = await start({ limits: { maxHeaderBytes: 1024 } });
  try {
    const exchange = (payload: string) => new Promise<string>((resolve, reject) => {
      const s = connect(h.port, "127.0.0.1"); let data = "";
      s.setTimeout(3000, () => { s.destroy(); reject(new Error("timeout")); });
      s.on("data", (c) => { data += c; }); s.on("close", () => resolve(data)); s.on("error", reject);
      s.write(payload);
    });
    const garbage = await exchange("NOT HTTP AT ALL\r\n\r\n");
    assert.match(garbage, /^HTTP\/1\.1 400 /); assert.ok(garbage.includes(`Content-Security-Policy: ${CSP}`)); assert.ok(garbage.includes("X-Content-Type-Options: nosniff")); assert.ok(garbage.includes('"schema":"error/1"'));
    const big = await exchange(`GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nX-Pad: ${"a".repeat(4096)}\r\n\r\n`);
    assert.match(big, /^HTTP\/1\.1 431 /); assert.ok(big.includes(`Content-Security-Policy: ${CSP}`));
  } finally { await h.close(); }
});

test("HSTS is sent, and the cookie is Secure and __Host- prefixed, only on a TLS listener", async (t) => {
  // A TLS listener needs a certificate; a throwaway one is made with openssl when it exists, otherwise the case is skipped.
  const { spawnSync } = await import("node:child_process"); const { mkdtempSync, readFileSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "api-tls-"));
  try {
    const gen = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    if (gen.status !== 0) { t.skip("openssl is not available"); return; }
    const { createApiServer } = await import("../src/server.ts"); const { fakeCore } = await import("./helpers.ts"); const https = await import("node:https");
    const api = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN, tls: { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) } });
    const { port } = await api.listen();
    try {
      const res = await new Promise<{ headers: Record<string, any>; status: number }>((resolve, reject) => {
        const rq = https.request({ host: "127.0.0.1", port, method: "POST", path: "/api/v1/session", headers: jsonHeaders(), rejectUnauthorized: false, agent: false }, (r) => { r.resume(); r.on("end", () => resolve({ headers: r.headers, status: r.statusCode ?? 0 })); });
        rq.on("error", reject); rq.end(JSON.stringify({ token: OWNER_TOKEN }));
      });
      assert.equal(res.status, 200);
      assert.match(res.headers["strict-transport-security"], /max-age=\d+/);
      assert.match(res.headers["set-cookie"][0], /^__Host-plur1bus_session=/); assert.match(res.headers["set-cookie"][0], /; Secure/); assert.match(res.headers["set-cookie"][0], /; Path=\//);
    } finally { await api.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
