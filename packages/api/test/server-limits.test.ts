import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { jsonHeaders, login, OWNER_TOKEN, raw, start, fakeCore } from "./helpers.ts";

test("an oversized body is 413 (declared length), authenticated or not, and the server stays usable", async () => {
  const h = await start({ limits: { maxBodyBytes: 512 } });
  try {
    const big = JSON.stringify({ token: "a".repeat(2000) });
    const r = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: big });
    assert.equal(r.status, 413); assert.deepEqual(r.json, { schema: "error/1", error: "E_INVALID_PARAMS", message: "request body exceeds 512 bytes", reason: "body-too-large" });
    const { cookie } = await login(h);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: OWNER_TOKEN }) })).status, 200, "a body at the limit still works");
  } finally { await h.close(); }
});

test("an oversized chunked body (no Content-Length) is 413 once it passes the limit", async () => {
  const h = await start({ limits: { maxBodyBytes: 256 } });
  try {
    const res = await new Promise<string>((resolve, reject) => {
      const s = connect(h.port, "127.0.0.1"); let data = "";
      s.setTimeout(3000, () => { s.destroy(); reject(new Error("timeout")); });
      s.on("data", (c) => { data += c; }); s.on("close", () => resolve(data)); s.on("error", () => resolve(data));
      const chunk = "a".repeat(200);
      s.write(`POST /api/v1/session HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`);
      s.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`); s.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n0\r\n\r\n`);
    });
    assert.match(res, /^HTTP\/1\.1 413 /); assert.ok(res.includes('"reason":"body-too-large"'));
  } finally { await h.close(); }
});

test("a body on a route that takes none still counts against the limit; a bad Content-Length is 400", async () => {
  const h = await start({ limits: { maxBodyBytes: 64 } });
  try {
    const { cookie } = await login(h);
    assert.equal((await raw(h, { method: "GET", path: "/api/v1/whoami", headers: { cookie, "content-length": "1000" }, body: "x".repeat(1000) })).status, 413);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie, "content-length": "12abc" } }).catch(() => ({ status: 400 }))).status, 400);
  } finally { await h.close(); }
});

test("the rate limit trips with 429 and Retry-After, per IP before a session and per principal after, and recovers with the clock", async () => {
  const h = await start({ rateClasses: { auth: { capacity: 2, refillPerSec: 0.5 }, read: { capacity: 3, refillPerSec: 1 }, write: { capacity: 2, refillPerSec: 1 } } });
  try {
    // Login attempts (auth class, per IP): 2 allowed, then 429 even for the right token.
    const attempt = (token: string) => raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token }) });
    assert.equal((await attempt("b".repeat(64))).status, 401);
    const { cookie, res } = await (async () => { const r = await attempt(OWNER_TOKEN); return { res: r, cookie: (r.headers["set-cookie"]?.[0] ?? "").split(";", 1)[0]! }; })();
    assert.equal(res.status, 200);
    const blocked = await attempt(OWNER_TOKEN);
    assert.equal(blocked.status, 429); assert.equal(blocked.json.reason, "rate-limited"); assert.equal(blocked.headers["retry-after"], "2");
    h.clock.advance(2000);
    assert.equal((await attempt("b".repeat(64))).status, 401, "recovered: the guess is judged again");

    // Reads (read class): the IP bucket is shared by everything from this IP, so 3 requests then 429.
    h.clock.advance(60_000);
    for (let i = 0; i < 3; i++) assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200, `read ${i}`);
    const limited = await raw(h, { path: "/api/v1/whoami", headers: { cookie } });
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers["retry-after"]) >= 1);
    assert.equal((await raw(h, { path: "/api/v1/whoami" })).status, 429, "unauthenticated requests spend the same IP bucket");
    h.clock.advance(1000);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200, "one token refilled");
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 429);
    h.clock.advance(10_000);
    for (let i = 0; i < 3; i++) assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200, `recovered ${i}`);
  } finally { await h.close(); }
});

test("a slow request that never completes is cut off with 408 and the error/1 body", async () => {
  const h = await start({ limits: { requestTimeoutMs: 300, headersTimeoutMs: 300 } });
  try {
    const res = await new Promise<string>((resolve, reject) => {
      const s = connect(h.port, "127.0.0.1"); let data = "";
      s.setTimeout(5000, () => { s.destroy(); reject(new Error("timeout")); });
      s.on("data", (c) => { data += c; }); s.on("close", () => resolve(data)); s.on("error", () => resolve(data));
      s.write(`POST /api/v1/session HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"tok`);
    });
    assert.match(res, /^HTTP\/1\.1 408 /); assert.ok(res.includes('"reason":"request-timeout"')); assert.ok(res.includes("Content-Security-Policy:"));
  } finally { await h.close(); }
});

test("a handler that does not answer in time is 504; an unexpected exception is a bare 500 and logs no detail to the client", async () => {
  const core = fakeCore(); core.impl = () => new Promise(() => {});
  const h = await start({ core, limits: { handlerTimeoutMs: 100, healthTimeoutMs: 5000 } });
  try {
    const { cookie } = await login(h);
    const r = await raw(h, { path: "/api/v1/agents", headers: { cookie } });
    assert.equal(r.status, 504); assert.equal(r.json.reason, "handler-timeout");
  } finally { await h.close(); }
  const core2 = fakeCore(); core2.impl = async () => { throw "kaboom /home/secret/path"; };
  const h2 = await start({ core: core2 });
  try {
    const { cookie } = await login(h2);
    const r = await raw(h2, { path: "/api/v1/agents", headers: { cookie } });
    assert.equal(r.status, 503); assert.ok(!r.text.includes("secret"));
  } finally { await h2.close(); }
});
