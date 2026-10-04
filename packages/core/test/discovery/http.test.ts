import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { gzipSync } from "node:zlib";
import { createPinnedClient, parseRetryAfter, ScanError, LIMITS } from "../../src/discovery/http.ts";
import type { PinnedClientOptions } from "../../src/discovery/http.ts";
import { startFakeEndpoint } from "../helpers/fake-endpoint.ts";
import type { FakeEndpoint, FakeReply, FakeRequest } from "../helpers/fake-endpoint.ts";

const UA = "plur1bus/0.1.0";
const lease = (origin: string, value = "Bearer CANARY-KEY-1") => ({ origin, headerName: "authorization", headerValue: value });
const opened: FakeEndpoint[] = [];
async function fake(h: (r: FakeRequest) => FakeReply): Promise<FakeEndpoint> { const f = await startFakeEndpoint(h); opened.push(f); return f; }
after(async () => { await Promise.all(opened.map((f) => f.close())); });
const client = (f: FakeEndpoint, o: Partial<PinnedClientOptions> = {}) =>
  createPinnedClient({ baseUrl: `${f.origin}/v1`, lease: lease(f.origin), userAgent: UA, ...o });
async function refused(p: Promise<unknown>, result: string, reason: string): Promise<ScanError> {
  try { await p; } catch (e) {
    assert.ok(e instanceof ScanError, `expected a ScanError, got ${String(e)}`);
    assert.equal(e.result, result); assert.equal(e.reason, reason);
    assert.ok(!e.message.includes("CANARY"), "message carries no secret");
    return e;
  }
  assert.fail(`expected ${result} ${reason}`);
}

describe("pinned client", () => {
  it("sends GET with the credential in a header and the plur1bus User-Agent only", async () => {
    const f = await fake(() => ({ json: { data: [] } }));
    await client(f).get({ path: "/models" });
    const h = f.requests[0]!.headers;
    assert.equal(h.authorization, "Bearer CANARY-KEY-1");
    assert.match(String(h["user-agent"]), /^plur1bus\/\d+\.\d+\.\d+/);
    assert.equal(h.cookie, undefined);
    assert.equal(f.requests[0]!.url, "/v1/models");
    assert.ok(!f.requests[0]!.url.includes("CANARY"));
  });

  it("works without a credential and with extra headers", async () => {
    const f = await fake(() => ({ json: { ok: true } }));
    const r = await client(f, { lease: null }).get({ path: "/models" }, { "anthropic-version": "2023-06-01" });
    assert.deepEqual(r, { ok: true });
    assert.equal(f.requests[0]!.headers.authorization, undefined);
    assert.equal(f.requests[0]!.headers["anthropic-version"], "2023-06-01");
  });

  it("refuses a non-JSON Content-Type", async () => {
    const f = await fake(() => ({ body: Buffer.from("<html>"), headers: { "Content-Type": "text/html" } }));
    await refused(client(f).get({ path: "/models" }), "failed:invalid", "content_type");
  });

  it("refuses a body over 4 MiB, declared or streamed", async () => {
    const big = Buffer.alloc(LIMITS.maxBodyBytes + 1, 0x20);
    const f = await fake(() => ({ body: big, headers: { "Content-Type": "application/json" } }));
    await refused(client(f).get({ path: "/models" }), "failed:invalid", "response_too_large");
    // streamed: the server omits Content-Length by sending chunked
    const { createServer } = await import("node:http");
    const s = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }); res.write(Buffer.alloc(3 * 1024 * 1024, 0x20)); res.end(Buffer.alloc(2 * 1024 * 1024, 0x20)); });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    const port = (s.address() as net.AddressInfo).port;
    try { await refused(createPinnedClient({ baseUrl: `http://127.0.0.1:${port}/v1`, lease: null, userAgent: UA }).get({ path: "/models" }), "failed:invalid", "response_too_large"); }
    finally { s.closeAllConnections(); s.close(); }
  });

  it("refuses a gzip bomb over the decompressed cap", async () => {
    const bomb = gzipSync(Buffer.alloc(LIMITS.maxBodyBytes + 1024 * 1024));
    assert.ok(bomb.length < 16 * 1024);
    const f = await fake(() => ({ body: bomb, headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } }));
    await refused(client(f).get({ path: "/models" }), "failed:invalid", "response_too_large");
  });

  it("accepts a gzip body under the cap", async () => {
    const f = await fake(() => ({ body: gzipSync(Buffer.from(JSON.stringify({ a: 1 }))), headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } }));
    assert.deepEqual(await client(f).get({ path: "/models" }), { a: 1 });
    assert.equal(f.requests[0]!.headers["accept-encoding"], "gzip, deflate, br");
  });

  it("refuses more than 8 MiB over all pages and an 11th page", async () => {
    const pad = (n: number) => Buffer.from(JSON.stringify({ pad: "x".repeat(n) }));
    const f = await fake(() => ({ body: pad(3 * 1024 * 1024), headers: { "Content-Type": "application/json" } }));
    const c = client(f);
    await c.get({ path: "/a" }); await c.get({ path: "/b" });
    await refused(c.get({ path: "/c" }), "failed:invalid", "response_too_large");
    const g = await fake(() => ({ json: {} }));
    const d = client(g);
    for (let i = 0; i < LIMITS.maxPages; i += 1) await d.get({ path: "/p" });
    assert.equal(d.pages, LIMITS.maxPages);
    await refused(d.get({ path: "/p" }), "failed:invalid", "too_many_pages");
  });

  it("times out a stalled request", async () => {
    const f = await fake(() => ({ stall: true }));
    await refused(client(f, { limits: { requestTimeoutMs: 50 } }).get({ path: "/models" }), "failed:network", "request_timeout");
  });

  it("times out the connect phase", async () => {
    const f = await fake(() => ({ json: {} }));
    const lookup = (() => { /* never calls back */ }) as unknown as net.LookupFunction;
    await refused(createPinnedClient({ baseUrl: `http://localhost:${f.port}/v1`, lease: null, userAgent: UA, lookup, limits: { connectTimeoutMs: 50 } }).get({ path: "/models" }), "failed:network", "connect_timeout");
    assert.equal(f.requests.length, 0);
  });

  it("does not follow a 302 to another origin", async () => {
    const second = await fake(() => ({ json: {} }));
    const first = await fake(() => ({ status: 302, headers: { Location: `${second.origin}/steal` } }));
    await refused(client(first).get({ path: "/models" }), "failed:invalid", "redirect_foreign_origin");
    assert.equal(second.requests.length, 0);
  });

  it("treats a Location differing only by port or by scheme as foreign", async () => {
    const target = await fake(() => ({ json: {} }));
    const other = await fake(() => ({ json: {} }));
    for (const loc of [`http://127.0.0.1:${target.port}/x`, `https://127.0.0.1:${other.port}/x`, `http://localhost:${other.port}/x`]) {
      const f = await fake(() => ({ status: 302, headers: { Location: loc } }));
      await refused(client(f).get({ path: "/models" }), "failed:invalid", "redirect_foreign_origin");
    }
    assert.equal(target.requests.length, 0); assert.equal(other.requests.length, 0);
  });

  it("follows at most 3 same-origin redirects", async () => {
    const count = (n: number) => fake((r) => {
      const hop = Number(new URL(r.url, "http://x").searchParams.get("hop") ?? "0");
      return hop < n ? { status: 302, headers: { Location: `/v1/models?hop=${hop + 1}` } } : { json: { done: hop } };
    });
    const three = await count(3);
    assert.deepEqual(await client(three).get({ path: "/models" }), { done: 3 });
    assert.equal(three.requests.every((r) => r.headers.authorization === "Bearer CANARY-KEY-1"), true);
    const four = await count(4);
    await refused(client(four).get({ path: "/models" }), "failed:invalid", "too_many_redirects");
  });

  it("sends a cursor that looks like a URL as an encoded query value to the same origin", async () => {
    const second = await fake(() => ({ json: {} }));
    const first = await fake(() => ({ json: { ok: 1 } }));
    const cursor = `${second.origin}/steal`;
    await client(first).get({ path: "/models", query: { pageToken: cursor } });
    assert.equal(second.requests.length, 0);
    assert.equal(new URL(first.requests[0]!.url, "http://x").searchParams.get("pageToken"), cursor);
  });

  it("two clients on two fakes never see each other's credential", async () => {
    const a = await fake(() => ({ json: {} })); const b = await fake(() => ({ json: {} }));
    await client(a, { lease: lease(a.origin, "Bearer CANARY-A") }).get({ path: "/models" });
    await client(b, { lease: lease(b.origin, "Bearer CANARY-B") }).get({ path: "/models" });
    assert.equal(a.requests[0]!.headers.authorization, "Bearer CANARY-A");
    assert.equal(b.requests[0]!.headers.authorization, "Bearer CANARY-B");
  });

  it("refuses a lease whose origin is not the base origin", async () => {
    assert.throws(() => createPinnedClient({ baseUrl: "http://127.0.0.1:1/v1", lease: lease("http://127.0.0.1:2"), userAgent: UA }), (e: unknown) => e instanceof ScanError && e.result === "failed:invalid");
  });

  it("maps statuses", async () => {
    const mk = (reply: FakeReply) => fake(() => reply);
    const e401 = await refused(client(await mk({ status: 401, body: Buffer.from("CANARY-KEY-1") })).get({ path: "/m" }), "failed:auth", "renew_sign_in");
    assert.equal(e401.httpStatus, 401);
    await refused(client(await mk({ status: 403 })).get({ path: "/m" }), "failed:auth", "renew_sign_in");
    const e429 = await refused(client(await mk({ status: 429, headers: { "Retry-After": "120" } })).get({ path: "/m" }), "failed:server", "rate_limited");
    assert.equal(e429.retryAfterMs, 120000);
    await refused(client(await mk({ status: 503 })).get({ path: "/m" }), "failed:server", "http_503");
    await refused(client(await mk({ status: 404 })).get({ path: "/m" }), "failed:invalid", "http_404");
    const dead = await startFakeEndpoint(() => ({})); const port = dead.port; await dead.close();
    await refused(createPinnedClient({ baseUrl: `http://127.0.0.1:${port}/v1`, lease: null, userAgent: UA }).get({ path: "/m" }), "failed:network", "connection_refused");
  });

  it("refuses a baseUrl with userinfo or a query", () => {
    for (const bad of ["https://u:CANARY-PW@example.invalid/v1", "https://example.invalid/v1?key=CANARY-Q"]) {
      try { createPinnedClient({ baseUrl: bad, lease: null, userAgent: UA }); assert.fail("should throw"); }
      catch (e) {
        assert.ok(e instanceof ScanError); assert.equal(e.result, "failed:invalid"); assert.equal(e.reason, "invalid_base_url");
        assert.ok(!e.message.includes("CANARY"));
      }
    }
  });

  it("refuses a credential over http to a non-loopback host before any socket", () => {
    const a = mock.method(net, "connect"); const b = mock.method(net, "createConnection");
    try {
      assert.throws(() => createPinnedClient({ baseUrl: "http://192.0.2.1/v1", lease: lease("http://192.0.2.1"), userAgent: UA }),
        (e: unknown) => e instanceof ScanError && e.reason === "insecure_transport" && e.result === "failed:invalid");
      assert.equal(a.mock.callCount() + b.mock.callCount(), 0);
    } finally { a.mock.restore(); b.mock.restore(); }
  });

  it("parseRetryAfter", () => {
    const now = 1_000_000;
    assert.equal(parseRetryAfter("120", now), 120000);
    assert.equal(parseRetryAfter(new Date(now + 90_000).toUTCString(), now), 90000);
    assert.equal(parseRetryAfter(String(10 * 86400), now), 86_400_000);
    assert.equal(parseRetryAfter(new Date(now + 10 * 86_400_000).toUTCString(), now), 86_400_000);
    assert.equal(parseRetryAfter("soon", now), undefined);
    assert.equal(parseRetryAfter(undefined, now), undefined);
    assert.equal(parseRetryAfter(new Date(now - 60_000).toUTCString(), now), 0);
  });

  it("no ScanError message contains a header value", async () => {
    const f = await fake(() => ({ status: 500, body: Buffer.from("Bearer CANARY-KEY-1") }));
    const e = await refused(client(f).get({ path: "/m" }), "failed:server", "http_500");
    assert.ok(!JSON.stringify({ m: e.message, r: e.reason }).includes("CANARY-KEY-1"));
  });

  it("refuses same-origin redirect with userinfo (Security M1)", async () => {
    const f = await fake((req) => {
      if (req.url === "/v1/redir") {
        return { status: 302, headers: { Location: `${f.origin.replace("://", "://user:pass@")}/v1/target` } };
      }
      return { json: { ok: true } };
    });
    await refused(client(f).get({ path: "/redir" }), "failed:invalid", "bad_redirect");
  });

  it("accepts deflate and br, rejects bombs and unknown encoding (Security M8)", async () => {
    const payload = JSON.stringify({ ok: true, data: "hello" });
    const { deflateSync, brotliCompressSync } = await import("node:zlib");
    // deflate ok
    const fDeflate = await fake(() => ({
      headers: { "Content-Type": "application/json", "Content-Encoding": "deflate" },
      body: deflateSync(Buffer.from(payload)),
    }));
    const rDeflate = await client(fDeflate).get({ path: "/m" });
    assert.deepEqual(rDeflate, { ok: true, data: "hello" });

    // br ok
    const fBr = await fake(() => ({
      headers: { "Content-Type": "application/json", "Content-Encoding": "br" },
      body: brotliCompressSync(Buffer.from(payload)),
    }));
    const rBr = await client(fBr).get({ path: "/m" });
    assert.deepEqual(rBr, { ok: true, data: "hello" });

    // deflate bomb (> 4 MiB)
    const bigBuf = Buffer.alloc(LIMITS.maxBodyBytes + 1024, 0x61);
    const fDeflateBomb = await fake(() => ({
      headers: { "Content-Type": "application/json", "Content-Encoding": "deflate" },
      body: deflateSync(bigBuf),
    }));
    await refused(client(fDeflateBomb).get({ path: "/m" }), "failed:invalid", "response_too_large");

    // br bomb (> 4 MiB)
    const fBrBomb = await fake(() => ({
      headers: { "Content-Type": "application/json", "Content-Encoding": "br" },
      body: brotliCompressSync(bigBuf),
    }));
    await refused(client(fBrBomb).get({ path: "/m" }), "failed:invalid", "response_too_large");

    // unknown encoding
    const fUnknown = await fake(() => ({
      headers: { "Content-Type": "application/json", "Content-Encoding": "zstd" },
      body: Buffer.from("data"),
    }));
    await refused(client(fUnknown).get({ path: "/m" }), "failed:invalid", "content_encoding");
  });

  it("localhost with credential verifies all resolved addresses are loopback (Security M5)", async () => {
    const f = await fake(() => ({ json: { ok: true } }));
    // Custom lookup returning a non-loopback IP for localhost
    const badLookup = (_hostname: string, _options: any, callback: any) => {
      const cb = typeof _options === "function" ? _options : callback;
      cb(null, [{ address: "198.51.100.1", family: 4 }]);
    };
    const c = createPinnedClient({
      baseUrl: `http://localhost:${f.port}/v1`,
      lease: lease(`http://localhost:${f.port}`),
      userAgent: UA,
      lookup: badLookup as any,
    });
    await refused(c.get({ path: "/m" }), "failed:invalid", "insecure_transport");

    // Mixed addresses: one loopback, one non-loopback -> must be refused
    const mixedLookup = (_hostname: string, _options: any, callback: any) => {
      const cb = typeof _options === "function" ? _options : callback;
      cb(null, [
        { address: "127.0.0.1", family: 4 },
        { address: "198.51.100.1", family: 4 },
      ]);
    };
    const cMixed = createPinnedClient({
      baseUrl: `http://localhost:${f.port}/v1`,
      lease: lease(`http://localhost:${f.port}`),
      userAgent: UA,
      lookup: mixedLookup as any,
    });
    await refused(cMixed.get({ path: "/m" }), "failed:invalid", "insecure_transport");

    // Pure loopback addresses -> accepted
    const goodLookup = (_hostname: string, _options: any, callback: any) => {
      const cb = typeof _options === "function" ? _options : callback;
      cb(null, [{ address: "127.0.0.1", family: 4 }]);
    };
    const cGood = createPinnedClient({
      baseUrl: `http://localhost:${f.port}/v1`,
      lease: lease(`http://localhost:${f.port}`),
      userAgent: UA,
      lookup: goodLookup as any,
    });
    const res = await cGood.get({ path: "/m" });
    assert.deepEqual(res, { ok: true });
  });

  it("abort clears the connect timer immediately (Security M7)", async () => {
    const f = await fake(() => ({ stall: true }));
    const ac = new AbortController();
    const c = createPinnedClient({
      baseUrl: `${f.origin}/v1`,
      lease: lease(f.origin),
      userAgent: UA,
      signal: ac.signal,
      limits: { connectTimeoutMs: 5000 },
    });
    const reqPromise = c.get({ path: "/m" });
    ac.abort();
    await refused(reqPromise, "failed:network", "aborted");
  });
});

