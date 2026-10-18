// The egress-checked HTTP client of the keyed search providers, against a loopback stub (nothing leaves the host).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSearchApiClient } from "../../../src/tools/web/search-http.ts";
import { WebFailure } from "../../../src/tools/web/failure.ts";
import type { EgressConfig } from "../../../src/egress/policy.ts";
import { startStub, stubResolver, never, type Stub } from "./helpers.ts";

const KEY = ["fixture", "key", "h4n8w1"].join("_");
const open: Stub[] = [];
const stub = async (h: Parameters<typeof startStub>[0]): Promise<Stub> => { const s = await startStub(h); open.push(s); return s; };
afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.close())); });
const allow = (s: Stub): EgressConfig => ({ allowHosts: ["127.0.0.1"], allowPorts: [s.port], allowLoopback: true });
const json = (res: import("node:http").ServerResponse, body: unknown, status = 200, type = "application/json"): void => { res.writeHead(status, { "content-type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
const fails = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof WebFailure && e.code === code && (!re || re.test(e.message)), `expected ${code}`);

describe("search API client", () => {
  it("sends method, headers and body; the key is a header, never part of the URL", async () => {
    let seenBody = "";
    const s = await stub((req, res) => { req.on("data", (c) => (seenBody += c)); req.on("end", () => json(res, { ok: true })); });
    const call = createSearchApiClient({ egress: () => allow(s), resolver: never });
    const r = await call({ method: "POST", url: `http://127.0.0.1:${s.port}/search?x=1`, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ query: "q" }) }, {});
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body.toString()), { ok: true });
    assert.equal(s.hits[0]!.url, "/search?x=1");
    assert.equal(s.hits[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(s.hits[0]!.headers["accept-encoding"], "identity");
    assert.equal(s.hits[0]!.headers["content-length"], String(Buffer.byteLength(seenBody)));
    assert.deepEqual(JSON.parse(seenBody), { query: "q" });
    assert.ok(!s.hits[0]!.url.includes(KEY));
  });

  it("egress default deny: a host that is not listed is refused before any lookup or connection", async () => {
    const s = await stub((_q, res) => json(res, {}));
    const call = createSearchApiClient({ egress: () => ({ allowHosts: [], allowPorts: [443], allowLoopback: false }), resolver: never });
    await fails(call({ method: "GET", url: "https://api.search.brave.com/res/v1/web/search?q=x", headers: { "x-subscription-token": KEY } }, {}), "egress-denied", /egress\.allowHosts/);
    await fails(call({ method: "GET", url: `http://127.0.0.1:${s.port}/`, headers: {} }, {}), "egress-denied");
    assert.equal(s.hits.length, 0);
  });

  it("plain http and other ports are refused for a public name; the refusal text holds no key", async () => {
    const call = createSearchApiClient({ egress: () => ({ allowHosts: ["api.search.brave.com"], allowPorts: [443], allowLoopback: false }), resolver: never });
    const e1 = await call({ method: "GET", url: "http://api.search.brave.com/x", headers: { "x-subscription-token": KEY } }, {}).catch((e: unknown) => e);
    assert.ok(e1 instanceof WebFailure && e1.code === "egress-denied" && !e1.message.includes(KEY));
    await fails(call({ method: "GET", url: "https://api.search.brave.com:8443/x", headers: {} }, {}), "egress-denied", /port/);
    await fails(call({ method: "GET", url: "https://user:pw@api.search.brave.com/x", headers: {} }, {}), "invalid-url");
  });

  it("a listed public name that resolves to a private or loopback address is refused (rebinding shape)", async () => {
    const s = await stub((_q, res) => json(res, {}));
    const cfg: EgressConfig = { allowHosts: ["search.test", "inner.test"], allowPorts: [s.port], allowLoopback: true };
    const call = createSearchApiClient({ egress: () => cfg, resolver: stubResolver({ "search.test": ["127.0.0.1"], "inner.test": ["10.1.2.3"] }) });
    await fails(call({ method: "GET", url: `http://search.test:${s.port}/`, headers: {} }, {}), "egress-denied");
    await fails(call({ method: "GET", url: `https://inner.test:${s.port}/`, headers: {} }, {}), "private-address");
    assert.equal(s.hits.length, 0);
  });

  it("does not follow redirects", async () => {
    const s = await stub((req, res) => { if (req.url === "/start") { res.writeHead(302, { location: "/elsewhere" }); res.end(); } else json(res, {}); });
    const call = createSearchApiClient({ egress: () => allow(s), resolver: never });
    await fails(call({ method: "GET", url: `http://127.0.0.1:${s.port}/start`, headers: {} }, {}), "http-error", /redirect/);
    assert.equal(s.hits.length, 1);
  });

  it("an error status returns status and headers without reading the body", async () => {
    const s = await stub((_q, res) => { res.writeHead(429, { "content-type": "application/json", "retry-after": "7" }); res.end(JSON.stringify({ detail: `echo ${KEY}` })); });
    const call = createSearchApiClient({ egress: () => allow(s), resolver: never });
    const r = await call({ method: "GET", url: `http://127.0.0.1:${s.port}/`, headers: {} }, {});
    assert.equal(r.status, 429);
    assert.equal(r.headers["retry-after"], "7");
    assert.equal(r.body.length, 0);
  });

  it("refuses a non-JSON 2xx, a compressed answer and an oversized one", async () => {
    const s = await stub((req, res) => {
      if (req.url === "/html") json(res, "<html></html>", 200, "text/html");
      else if (req.url === "/gz") { res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }); res.end("x"); }
      else json(res, JSON.stringify({ pad: "x".repeat(5000) }));
    });
    const call = createSearchApiClient({ egress: () => allow(s), resolver: never, maxBytes: 1000 });
    const url = (p: string): string => `http://127.0.0.1:${s.port}${p}`;
    await fails(call({ method: "GET", url: url("/html"), headers: {} }, {}), "http-error", /JSON/);
    await fails(call({ method: "GET", url: url("/gz"), headers: {} }, {}), "http-error", /compressed/);
    await fails(call({ method: "GET", url: url("/big"), headers: {} }, {}), "too-large");
  });

  it("a streamed body beyond the cap is cut without a declared length", async () => {
    const s = await stub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("[".padEnd(600, " ")); setTimeout(() => { res.write(" ".repeat(600)); res.end("]"); }, 20); });
    const call = createSearchApiClient({ egress: () => allow(s), resolver: never, maxBytes: 1000 });
    await fails(call({ method: "GET", url: `http://127.0.0.1:${s.port}/`, headers: {} }, {}), "too-large");
  });

  it("a hanging server hits the deadline; a caller's abort stops the call", async () => {
    const s = await stub(() => { /* never answers */ });
    const slow = createSearchApiClient({ egress: () => allow(s), resolver: never, timeoutMs: 150 });
    await fails(slow({ method: "GET", url: `http://127.0.0.1:${s.port}/`, headers: {} }, {}), "timeout");
    const ac = new AbortController();
    const patient = createSearchApiClient({ egress: () => allow(s), resolver: never, timeoutMs: 5000 });
    const p = patient({ method: "GET", url: `http://127.0.0.1:${s.port}/`, headers: {} }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await fails(p, "timeout");
  });

  it("reads the egress configuration per call", async () => {
    const s = await stub((_q, res) => json(res, {}));
    let cfg: EgressConfig = { allowHosts: [], allowPorts: [s.port], allowLoopback: true };
    const call = createSearchApiClient({ egress: () => cfg, resolver: never });
    await fails(call({ method: "GET", url: `http://127.0.0.1:${s.port}/`, headers: {} }, {}), "egress-denied");
    cfg = allow(s);
    assert.equal((await call({ method: "GET", url: `http://127.0.0.1:${s.port}/`, headers: {} }, {})).status, 200);
  });

  it("reports every gate decision for the egress counters", async () => {
    const s = await stub((_q, res) => json(res, {}));
    const decisions: unknown[] = [];
    const call = createSearchApiClient({ egress: () => allow(s), resolver: never, onDecision: (d) => decisions.push(d) });
    await call({ method: "GET", url: `http://127.0.0.1:${s.port}/`, headers: {} }, {});
    await call({ method: "GET", url: "https://not-listed.example/", headers: {} }, {}).catch(() => undefined);
    assert.deepEqual(decisions, [{ allowed: true }, { allowed: false, reason: "port" }]);
  });
});
