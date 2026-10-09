import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, DEFAULT_LIMITS, loopbackBind, type ApiServerOptions } from "../src/server.ts";
import { ApiError } from "../src/errors.ts";
import { memoryAuditSink } from "../src/rbac-bridge.ts";
import type { Handler, RouteSpec } from "../src/routes.ts";
import { MemoryUserDirectory } from "../src/memory-stores.ts";
import { addUser, fakeCore, jsonHeaders, login, loginAs, OWNER_TOKEN, raw, start, write, type Harness, type StartOptions } from "./helpers.ts";

type Any = any;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function up(o: StartOptions = {}): Promise<Harness> { const h = await start(o); cleanups.push(() => h.close()); return h; }
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; }

/** One request as raw text over a plain socket; resolves with everything the server sent until it closed. */
function exchange(port: number, payload: string | Buffer[], o: { end?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1"); let data = "";
    s.setTimeout(5000, () => { s.destroy(); reject(new Error("test client timeout")); });
    s.on("data", (c) => { data += c; }); s.on("close", () => resolve(data)); s.on("error", () => resolve(data));
    if (typeof payload === "string") s.write(payload); else for (const p of payload) s.write(p);
    if (o.end) s.end();
  });
}
const status = (text: string): number => Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
const bodyOf = (text: string): Any => { try { return JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)); } catch { return undefined; } };

function route(over: Partial<RouteSpec> & { id: string; path: string }): RouteSpec {
  return {
    method: "GET", summary: "x", tag: "t", auth: "none", authz: "public", csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "ok", schema: {} }, ...over,
  } as RouteSpec;
}
const ok: Handler = () => ({ body: { ok: true } });

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe("loopbackBind", () => {
  const good: Array<[string, string]> = [["127.0.0.1", "127.0.0.1"], ["127.255.255.254", "127.255.255.254"], ["::1", "::1"], ["localhost", "127.0.0.1"]];
  for (const [input, want] of good) it(`accepts ${input}`, () => assert.equal(loopbackBind(input), want));
  const bad = ["0.0.0.0", "::", "10.0.0.1", "128.0.0.1", "example.com", "", "LOCALHOST", "[::1]", "::ffff:127.0.0.1", "127.0.0.1 ", "127.0.0.1.nip.io", "::2", "0:0:0:0:0:0:0:1"];
  for (const input of bad) it(`refuses ${JSON.stringify(input)}`, () => assert.throws(() => loopbackBind(input), /loopback only/));
});

describe("createApiServer: construction", () => {
  const base = (): ApiServerOptions => ({ core: fakeCore(), ownerToken: OWNER_TOKEN });

  it("exposes the documented default limits", () => {
    assert.deepEqual(DEFAULT_LIMITS, { maxBodyBytes: 65536, handlerTimeoutMs: 10000, healthTimeoutMs: 2000, requestTimeoutMs: 15000, headersTimeoutMs: 10000, keepAliveTimeoutMs: 5000, maxConnections: 128, maxHeaderBytes: 16384 });
  });

  const refusals: Array<[string, () => ApiServerOptions, RegExp]> = [
    ["a non-loopback host", () => ({ ...base(), host: "0.0.0.0" }), /loopback only/],
    ["a short owner token", () => ({ ...base(), ownerToken: "x".repeat(31) }), /owner token/],
    ["tls without a certificate", () => ({ ...base(), tls: { key: "k", cert: "" } }), /tls needs both/],
    ["tls without a key", () => ({ ...base(), tls: { key: "", cert: "c" } }), /tls needs both/],
    ["a missing web root", () => ({ ...base(), webRoot: join(tmpdir(), "does-not-exist-api-cov") }), /is not a directory/],
    ["an extra route without handler", () => ({ ...base(), extraRoutes: [{ spec: route({ id: "nohandler", path: "/api/v1/nohandler" }), handler: undefined as unknown as Handler }] }), /no handler for route nohandler/],
  ];
  for (const [label, make, re] of refusals) it(`refuses ${label}`, () => assert.throws(() => createApiServer(make()), re));

  it("refuses a web root that is a file", () => {
    const d = tmp("api-srv-"); writeFileSync(join(d, "f"), "x");
    assert.throws(() => createApiServer({ ...base(), webRoot: join(d, "f") }), /is not a directory/);
  });

  it("close() on a server that never listened resolves", async () => {
    const api = createApiServer(base());
    await api.close();
  });

  it("rightsChanged is 0 when the user has no session", () => {
    assert.equal(createApiServer(base()).rightsChanged("nobody"), 0);
  });
});

describe("listen and close", () => {
  it("listens on port 0, reports host/port/url, and refuses a second listener on the same port", async () => {
    const h = await up();
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(h.url, `http://127.0.0.1:${h.port}`);
    assert.ok(h.logs.some((l) => l.includes('"msg":"listening"')));
    const clash = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN, port: h.port });
    await assert.rejects(clash.listen(), (e: NodeJS.ErrnoException) => e.code === "EADDRINUSE");
    await clash.close();
  });

  it("rejects when the listener has no usable address", async (t) => {
    const api = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN });
    t.mock.method(api.server, "address", () => null);
    await assert.rejects(api.listen(), /no address/);
    t.mock.restoreAll();
    await api.close();
  });

  it("an IPv6 loopback host is bracketed in the URL", async (t) => {
    const api = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN, host: "::1" });
    let r: { host: string; port: number; url: string };
    try { r = await api.listen(); } catch (e) { if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes((e as NodeJS.ErrnoException).code ?? "")) { t.skip("no IPv6 loopback"); return; } throw e; }
    try { assert.equal(r.host, "::1"); assert.equal(r.url, `http://[::1]:${r.port}`); } finally { await api.close(); }
  });

  it("the break-glass sweeper runs every 30 s and a failing sweep never escapes (fake timers)", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let boom = false;
    const api = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN, clock: { now: () => { if (boom) throw new Error("clock failed"); return 1_700_000_000_000; } } });
    await api.listen();
    try {
      t.mock.timers.tick(30_000);
      boom = true;
      t.mock.timers.tick(30_000);
      boom = false;
    } finally { await api.close(); }
  });

  it("a request in flight does not keep close() waiting", async () => {
    const h = await start();
    const hang = exchange(h.port, `GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nContent-Length: 10\r\n\r\n12`);
    await h.close();
    await hang;
  });
});

describe("request gate: Host, target, Origin, Referer, Sec-Fetch-Site", () => {
  it("421 for a foreign or missing Host; localhost and 127.0.0.1 with the right port (any case) pass", async () => {
    const h = await up();
    for (const host of ["evil.example", `127.0.0.1:${h.port + 1}`, "127.0.0.1", `localhost`]) {
      const r = await raw(h, { path: "/api/v1/health", headers: { host } });
      assert.equal(r.status, 421, host); assert.equal(r.json.reason, "host");
    }
    assert.equal(status(await exchange(h.port, "GET /api/v1/health HTTP/1.0\r\n\r\n")), 421);
    for (const host of [`localhost:${h.port}`, `LOCALHOST:${h.port}`, `127.0.0.1:${h.port}`, `[::1]:${h.port}`]) {
      assert.equal((await raw(h, { path: "/api/v1/health", headers: { host } })).status, 401, host);
    }
  });

  it("400 when the request target is not origin-form", async () => {
    const h = await up();
    const res = await exchange(h.port, `OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nConnection: close\r\n\r\n`);
    assert.equal(status(res), 400); assert.equal(bodyOf(res).reason, "target");
  });

  it("a query string is ignored when routing", async () => {
    const h = await up();
    assert.equal((await raw(h, { path: "/api/v1/health?x=1&y=2" })).status, 401);
  });

  it("403 origin for an Origin the API did not issue; its own origin passes in any case", async () => {
    const h = await up();
    for (const origin of ["http://evil.example", "null", `http://127.0.0.1:${h.port + 1}`, `https://127.0.0.1:${h.port}`]) {
      const r = await raw(h, { path: "/api/v1/health", headers: { origin } });
      assert.equal(r.status, 403, origin); assert.equal(r.json.reason, "origin");
    }
    for (const origin of [`http://127.0.0.1:${h.port}`, `HTTP://LOCALHOST:${h.port}`, `http://[::1]:${h.port}`]) {
      assert.equal((await raw(h, { path: "/api/v1/health", headers: { origin } })).status, 401, origin);
    }
  });

  it("an origin refusal does not spend the rate bucket", async () => {
    const h = await up({ rateClasses: { auth: { capacity: 5, refillPerSec: 1 }, read: { capacity: 2, refillPerSec: 0.001 }, write: { capacity: 5, refillPerSec: 1 } } });
    for (let i = 0; i < 5; i++) assert.equal((await raw(h, { path: "/api/v1/health", headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await raw(h, { path: "/api/v1/health" })).status, 401);
  });

  const badReferers = ["http://evil.example/", "not a url", "null", "ftp://127.0.0.1/", "//127.0.0.1", "javascript:alert(1)", ""];
  for (const referer of badReferers) it(`a write with Referer ${JSON.stringify(referer)} is 403 referer`, async () => {
    const h = await up();
    const r = await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), referer }, body: JSON.stringify({ token: OWNER_TOKEN }) });
    assert.equal(r.status, 403); assert.equal(r.json.reason, "referer");
  });

  it("a write with the API's own Referer works; reads and HEAD may carry any Referer", async () => {
    const h = await up();
    const own = await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), referer: `${h.url}/login?x=1` }, body: JSON.stringify({ token: OWNER_TOKEN }) });
    assert.equal(own.status, 200);
    assert.equal((await raw(h, { path: "/api/v1/health", headers: { referer: "http://elsewhere.example/" } })).status, 401);
    assert.equal((await raw(h, { method: "HEAD", path: "/api/v1/health", headers: { referer: "http://elsewhere.example/" } })).status, 405);
    assert.equal((await raw(h, { method: "OPTIONS", path: "/api/v1/health", headers: { referer: "http://elsewhere.example/" } })).status, 405);
  });

  it("Sec-Fetch-Site: cross-site and same-site are 403, same-origin and none pass", async () => {
    const h = await up();
    for (const v of ["cross-site", "same-site", "bogus"]) {
      const r = await raw(h, { path: "/api/v1/health", headers: { "sec-fetch-site": v } });
      assert.equal(r.status, 403, v); assert.equal(r.json.reason, "cross-site");
    }
    for (const v of ["same-origin", "none"]) assert.equal((await raw(h, { path: "/api/v1/health", headers: { "sec-fetch-site": v } })).status, 401, v);
  });
});

describe("routing", () => {
  it("404 for an unknown path, 405 with Allow for a known path and wrong method", async () => {
    const h = await up();
    const nf = await raw(h, { path: "/api/v1/nothing" });
    assert.equal(nf.status, 404); assert.equal(nf.json.reason, "route");
    const mm = await raw(h, { method: "PUT", path: "/api/v1/session" });
    assert.equal(mm.status, 405); assert.equal(mm.headers.allow, "POST, DELETE");
    assert.equal(mm.json.reason, "method-not-allowed");
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/health" })).headers.allow, "GET");
    assert.equal((await raw(h, { path: "/" })).status, 404, "no web root: JSON only");
  });

  it("answers every response with the security headers and a Content-Length", async () => {
    const h = await up();
    const r = await raw(h, { path: "/api/v1/health" });
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(r.text));
  });

  it("serves the table's routes through the dispatcher (health with the owner, whoami, agents)", async () => {
    const h = await up(); const { cookie } = await login(h);
    const health = await raw(h, { path: "/api/v1/health", headers: { cookie } });
    assert.equal(health.status, 200); assert.equal(health.json.status, "ok");
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).json.principal.kind, "owner");
    assert.equal((await raw(h, { path: "/api/v1/agents", headers: { cookie } })).json.agents.length, 1);
  });
});

describe("static files", () => {
  function web(): string {
    const root = tmp("api-web-");
    writeFileSync(join(root, "index.html"), '<!doctype html><script src="/app.js"></script><style>b{}</style>');
    writeFileSync(join(root, "app.js"), "console.log(1)");
    mkdirSync(join(root, "sub"));
    return root;
  }

  it("serves the shell with a per-response CSP nonce, assets without one, HEAD without a body", async () => {
    const h = await up({ webRoot: web() });
    const shell = await raw(h, { path: "/" });
    assert.equal(shell.status, 200); assert.match(shell.headers["content-type"]!, /^text\/html/);
    const nonce = /nonce="([^"]+)"/.exec(shell.text)?.[1]!;
    assert.ok(nonce);
    assert.ok(String(shell.headers["content-security-policy"]).includes(`'nonce-${nonce}'`));
    const again = await raw(h, { path: "/some/client/route" });
    assert.equal(again.status, 200);
    assert.notEqual(/nonce="([^"]+)"/.exec(again.text)?.[1], nonce, "a fresh nonce per response");
    const js = await raw(h, { path: "/app.js" });
    assert.equal(js.status, 200); assert.match(js.headers["content-type"]!, /javascript/);
    assert.ok(!String(js.headers["content-security-policy"]).includes("nonce-"));
    const head = await raw(h, { method: "HEAD", path: "/" });
    assert.equal(head.status, 200); assert.equal(head.text, "");
    assert.ok(Number(head.headers["content-length"]) > 0);
  });

  it("404 for a missing asset or a hidden path, 405 for a write, and /api stays JSON", async () => {
    const h = await up({ webRoot: web() });
    assert.equal((await raw(h, { path: "/missing.js" })).status, 404);
    assert.equal((await raw(h, { path: "/.git/config" })).status, 404);
    assert.equal((await raw(h, { path: "/%2e%2e/etc/passwd" })).status, 404);
    const post = await raw(h, { method: "POST", path: "/", headers: jsonHeaders(), body: "{}" });
    assert.equal(post.status, 405); assert.equal(post.headers.allow, "GET, HEAD");
    const api = await raw(h, { path: "/api/v1/unknown" });
    assert.equal(api.status, 404); assert.equal(api.json.schema, "error/1");
    assert.equal((await raw(h, { path: "/api" })).json?.schema, "error/1");
    assert.equal((await raw(h, { path: "/api/" })).json?.schema, "error/1");
    assert.equal((await raw(h, { path: "/apix" })).status, 200, "only /api and /api/ are reserved");
  });

  it("a web root does not weaken the API", async () => {
    const h = await up({ webRoot: web() });
    assert.equal((await raw(h, { path: "/api/v1/whoami" })).status, 401);
  });
});

describe("Content-Length and body handling", () => {
  it("400 for a non-numeric, signed or unsafe Content-Length", async () => {
    const h = await up();
    for (const v of ["12abc", "-1", "+5", "1.5", " ", "99999999999999999999"]) {
      const res = await exchange(h.port, `POST /api/v1/session HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nContent-Type: application/json\r\nContent-Length: ${v}\r\nConnection: close\r\n\r\n`);
      const s = status(res);
      assert.ok(s === 400, `${JSON.stringify(v)} -> ${s}`);
    }
  });

  it("413 above the limit by declared length, and a body at the limit is parsed", async () => {
    const h = await up({ limits: { maxBodyBytes: 100 } });
    const big = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: "x".repeat(101) });
    assert.equal(big.status, 413);
    assert.equal(big.json.reason, "body-too-large");
    const exact = JSON.stringify({ token: "t".repeat(100 - 12) }); assert.equal(exact.length, 100);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: exact })).status, 401);
  });

  it("a huge declared body is drained only up to a cap and the connection is dropped", async () => {
    const h = await up({ limits: { maxBodyBytes: 16 } });
    const chunk = Buffer.alloc(32 * 1024, 0x61);
    const res = await exchange(h.port, [Buffer.from(`POST /api/v1/session HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n`), chunk, chunk, chunk, chunk]);
    assert.ok(res === "" || status(res) === 413);
  });

  it("415 without a JSON content type (missing, wrong, charset allowed)", async () => {
    const h = await up();
    const body = JSON.stringify({ token: OWNER_TOKEN });
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", body })).status, 415);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: { "content-type": "text/plain" }, body })).status, 415);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: { "content-type": "application/json; charset=utf-8" }, body })).status, 200);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: { "content-type": "Application/JSON" }, body })).status, 200);
  });

  it("400 for an empty body and for invalid JSON; the JSON value itself is judged by the handler", async () => {
    const h = await up();
    const empty = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders() });
    assert.equal(empty.status, 400); assert.equal(empty.json.reason, "body");
    const bad = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: "{nope" });
    assert.equal(bad.status, 400); assert.equal(bad.json.reason, "json");
    const wrong = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: "[]" });
    assert.equal(wrong.status, 400); assert.equal(wrong.json.reason, "body");
  });

  it("a small body on a route that takes none is read and ignored; Content-Length 0 is fine", async () => {
    const h = await up(); const { cookie } = await login(h);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie, "content-length": "5" }, body: "hello" })).status, 200);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie, "content-length": "0" } })).status, 200);
  });

  it("a client that disconnects mid-body does not break the server", async () => {
    const h = await up();
    const s = connect(h.port, "127.0.0.1");
    await new Promise<void>((r) => s.once("connect", () => r()));
    s.write(`POST /api/v1/session HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"tok`);
    await new Promise((r) => setTimeout(r, 20));
    s.destroy();
    await until(() => h.logs.some((l) => l.includes('"msg":"request"') && l.includes('"route":"session.create"')));
    assert.equal((await raw(h, { path: "/api/v1/health" })).status, 401);
  });
});

describe("authentication: session", () => {
  it("401 without a cookie and with an unknown one", async () => {
    const h = await up();
    const none = await raw(h, { path: "/api/v1/whoami" });
    assert.equal(none.status, 401); assert.equal(none.json.reason, "no-session");
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie: "plur1bus_session=nope" } })).status, 401);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie: "__Host-plur1bus_session=nope; other=1" } })).status, 401);
  });

  it("a write needs a fresh one-time CSRF token: missing, wrong and reused are 403 and audited once", async () => {
    const h = await up(); const { cookie } = await login(h);
    const missing = await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie } });
    assert.equal(missing.status, 403); assert.equal(missing.json.reason, "csrf");
    assert.equal((await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie, "x-csrf-token": "wrong" } })).status, 403);
    assert.ok(h.audit.events.some((e: Any) => e.action === "auth.csrf-refused"));
    const out = await write(h, cookie, { method: "DELETE", path: "/api/v1/session" });
    assert.equal(out.status, 200);
    assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 401, "the session is gone");
  });

  it("a disabled account loses its session at the next request", async () => {
    const h = await up(); await addUser(h, { id: "u1", username: "alice", role: "member" });
    const { cookie } = await loginAs(h, "alice");
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200);
    h.users.change("u1", { disabled: true });
    const r = await raw(h, { path: "/api/v1/whoami", headers: { cookie } });
    assert.equal(r.status, 401); assert.equal(r.json.reason, "session-expired");
    h.users.change("u1", { disabled: false });
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 401, "the session was destroyed, not parked");
  });

  it("a changed role rotates the cookie once; rightsChanged() forces the same", async () => {
    const h = await up(); await addUser(h, { id: "u1", username: "alice", role: "admin" });
    const { cookie } = await loginAs(h, "alice");
    h.users.change("u1", { role: "operator" });
    const rotated = await raw(h, { path: "/api/v1/whoami", headers: { cookie } });
    assert.equal(rotated.status, 200); assert.equal(rotated.json.principal.role, "operator");
    const fresh = String(rotated.headers["set-cookie"]).split(";", 1)[0]!;
    assert.notEqual(fresh, cookie);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 401, "the old value is dead");
    const again = await raw(h, { path: "/api/v1/whoami", headers: { cookie: fresh } });
    assert.equal(again.status, 200); assert.equal(again.headers["set-cookie"], undefined);
    assert.equal(h.api.rightsChanged("u1"), 1);
    const forced = await raw(h, { path: "/api/v1/whoami", headers: { cookie: fresh } });
    assert.ok(forced.headers["set-cookie"]);
    assert.ok(h.audit.events.some((e: Any) => e.action === "auth.session.rotated"));
  });

  it("a role without the right gets 403; only non-GET denials are audited", async () => {
    const extra = [
      { spec: route({ id: "x.read", path: "/api/v1/x/read", auth: "session", authz: { action: "users.manage" } }), handler: ok },
      { spec: route({ id: "x.write", method: "POST", path: "/api/v1/x/write", auth: "session", authz: { action: "users.manage" }, csrf: true, rate: "write" }), handler: ok },
    ];
    const h = await up({ extraRoutes: extra }); await addUser(h, { id: "v1", username: "vera", role: "viewer" });
    const { cookie } = await loginAs(h, "vera");
    const get = await raw(h, { path: "/api/v1/x/read", headers: { cookie } });
    assert.equal(get.status, 403); assert.equal(get.json.reason, "role-denied");
    assert.ok(!h.audit.events.some((e: Any) => e.action === "auth.denied"));
    const post = await write(h, cookie, { path: "/api/v1/x/write" });
    assert.equal(post.status, 403);
    const ev = h.audit.events.find((e: Any) => e.action === "auth.denied") as Any;
    assert.equal(ev.target, "route:x.write"); assert.equal(ev.detail.action, "users.manage");
    const { cookie: owner } = await login(h);
    assert.equal((await raw(h, { path: "/api/v1/x/read", headers: { cookie: owner } })).status, 200);
  });

  it("a non-GET session denial of a route declared public is audited without an action", async () => {
    const extra = [{ spec: route({ id: "x.pub", method: "POST", path: "/api/v1/x/pub", auth: "session", authz: "public", csrf: true, rate: "write" }), handler: ok }];
    const h = await up({ extraRoutes: extra });
    const { cookie } = await login(h);
    assert.equal((await write(h, cookie, { path: "/api/v1/x/pub" })).status, 403);
    const ev = h.audit.events.find((e: Any) => e.action === "auth.denied") as Any;
    assert.ok(!("action" in ev.detail)); assert.equal(ev.detail.reason, "unknown-action");
  });

  it("a user's agent and project rights are part of the principal that is authorised", async () => {
    const h = await up();
    h.users.add({ id: "r1", username: "rita", role: "member", agentRights: { main: "use" }, projectRights: { p1: "edit" as Any } });
    h.users.add({ id: "r2", username: "ron", role: "member" });
    await Promise.all(["rita", "ron"].map(async (n) => { const u = await h.users.findByUsername(n); h.users.change(u!.id, { passwordHash: (await (await import("../src/password.ts")).hashPassword("fixture-pass-not-a-real-secret")) }); }));
    const { cookie } = await loginAs(h, "rita");
    const agents = await raw(h, { path: "/api/v1/agents", headers: { cookie } });
    assert.equal(agents.status, 200); assert.deepEqual(agents.json.agents.map((a: Any) => a.agentId), ["main"]);
    const { cookie: other } = await loginAs(h, "ron");
    assert.deepEqual((await raw(h, { path: "/api/v1/agents", headers: { cookie: other } })).json.agents, []);
  });

  it("authorization resources: self, user and system are all evaluated", async () => {
    const h = await up(); await addUser(h, { id: "a1", username: "adam", role: "admin" }); await addUser(h, { id: "m1", username: "mia", role: "member" });
    const admin = (await loginAs(h, "adam")).cookie; const member = (await loginAs(h, "mia")).cookie;
    assert.equal((await raw(h, { path: "/api/v1/tokens", headers: { cookie: member } })).status, 200, "self");
    assert.equal((await raw(h, { path: "/api/v1/breakglass", headers: { cookie: admin } })).status, 200, "user");
    assert.equal((await raw(h, { path: "/api/v1/breakglass", headers: { cookie: member } })).status, 403, "user, denied for a member");
    assert.equal((await raw(h, { path: "/api/v1/health", headers: { cookie: member } })).status, 403, "system");
  });
});

describe("authentication: declarations are enforced", () => {
  it("a session route that declares nothing, or declares public, is refused", async () => {
    const extra = [
      { spec: route({ id: "u.none", path: "/api/v1/u/none", auth: "session", authz: undefined as unknown as RouteSpec["authz"] }), handler: ok },
      { spec: route({ id: "u.pub", path: "/api/v1/u/pub", auth: "session", authz: "public" }), handler: ok },
      { spec: route({ id: "u.noauth", path: "/api/v1/u/noauth", auth: "none", authz: "authenticated" }), handler: ok },
      { spec: route({ id: "u.noauth2", path: "/api/v1/u/noauth2", auth: "none", authz: undefined as unknown as RouteSpec["authz"] }), handler: ok },
    ];
    const h = await up({ extraRoutes: extra }); const { cookie } = await login(h);
    const a = await raw(h, { path: "/api/v1/u/none", headers: { cookie } });
    assert.equal(a.status, 403); assert.equal(a.json.reason, "undeclared-route");
    const b = await raw(h, { path: "/api/v1/u/pub", headers: { cookie } });
    assert.equal(b.status, 403); assert.equal(b.json.reason, "unknown-action");
    for (const p of ["noauth", "noauth2"]) {
      const c = await raw(h, { path: `/api/v1/u/${p}`, headers: { cookie } });
      assert.equal(c.status, 403, p); assert.equal(c.json.reason, "undeclared-route");
    }
  });

  it("a public route runs without any credential and sees the presented cookie only when auth is none", async () => {
    const seen: Any[] = [];
    const extra = [{ spec: route({ id: "p.ok", path: "/api/v1/p/ok" }), handler: ((i: Any) => { seen.push(i); return { body: { ok: true } }; }) as Handler }];
    const h = await up({ extraRoutes: extra });
    assert.equal((await raw(h, { path: "/api/v1/p/ok", headers: { cookie: "plur1bus_session=abc" } })).status, 200);
    assert.equal(seen[0].presentedSessionId, "abc");
    assert.equal(seen[0].principal, undefined);
    assert.equal(seen[0].ip, "127.0.0.1");
  });
});

describe("authentication: personal API tokens", () => {
  async function mint(h: Harness, cookie: string, scopes: string[] = ["agent.*"]): Promise<{ token: string; id: string }> {
    const r = await write(h, cookie, { path: "/api/v1/tokens", body: { name: "ci", scopes } });
    assert.equal(r.status, 201, r.text);
    return { token: r.json.token as string, id: r.json.record.id as string };
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it("a token reaches whoami and its allowed route, with no cookie or CSRF", async () => {
    const h = await up(); const { cookie } = await login(h); const { token, id } = await mint(h, cookie);
    const who = await raw(h, { path: "/api/v1/whoami", headers: bearer(token) });
    assert.equal(who.status, 200); assert.equal(who.json.via, "token"); assert.equal(who.json.token.id, id);
    assert.equal(who.json.principal.kind, "owner");
    assert.equal((await raw(h, { path: "/api/v1/agents", headers: bearer(token) })).status, 200);
    assert.equal((await raw(h, { path: "/api/v1/agents", headers: { authorization: `bearer ${token}` } })).status, 200, "scheme is case-insensitive");
    assert.equal((await raw(h, { path: "/api/v1/agents", headers: { authorization: `Bearer   ${token}  ` } })).status, 200);
  });

  it("a token cannot reach what its scopes exclude (403 token-scope), and a GET denial is not audited", async () => {
    const h = await up(); const { cookie } = await login(h); const { token } = await mint(h, cookie);
    const r = await raw(h, { path: "/api/v1/health", headers: bearer(token) });
    assert.equal(r.status, 403); assert.equal(r.json.reason, "token-scope");
    assert.ok(!h.audit.events.some((e: Any) => e.action === "auth.denied"));
  });

  it("a non-GET denial by token scope is audited with the via and action", async () => {
    const extra = [{ spec: route({ id: "t.post", method: "POST", path: "/api/v1/t/post", auth: "any", authz: { action: "users.manage" }, rate: "write" }), handler: ok }];
    const h = await up({ extraRoutes: extra }); const { cookie } = await login(h); const { token } = await mint(h, cookie);
    const r = await raw(h, { method: "POST", path: "/api/v1/t/post", headers: bearer(token) });
    assert.equal(r.status, 403);
    const ev = h.audit.events.find((e: Any) => e.action === "auth.denied") as Any;
    assert.equal(ev.detail.via, "token"); assert.equal(ev.detail.action, "users.manage");
    assert.equal(ev.target, "route:t.post");
  });

  it("BUG: the audit entry of a token denial keeps the token id", { skip: "BUG: redactFields blanks the audit field 'token' (name matches the credential pattern) – siehe docs/testing/coverage-2026-10.md#api-server-audit-token-id-redacted" }, async () => {
    const extra = [{ spec: route({ id: "t.post", method: "POST", path: "/api/v1/t/post", auth: "any", authz: { action: "users.manage" }, rate: "write" }), handler: ok }];
    const h = await up({ extraRoutes: extra }); const { cookie } = await login(h); const { token, id } = await mint(h, cookie);
    await raw(h, { method: "POST", path: "/api/v1/t/post", headers: bearer(token) });
    const ev = h.audit.events.find((e: Any) => e.action === "auth.denied") as Any;
    assert.equal(ev.detail.token, id);
  });

  it("a non-GET denial of an authenticated-only declaration carries no action", async () => {
    const extra = [{ spec: route({ id: "t.pub", method: "POST", path: "/api/v1/t/pub", auth: "any", authz: "public", rate: "write" }), handler: ok }];
    const h = await up({ extraRoutes: extra }); const { cookie } = await login(h); const { token } = await mint(h, cookie);
    const r = await raw(h, { method: "POST", path: "/api/v1/t/pub", headers: bearer(token) });
    assert.equal(r.status, 403);
    const ev = h.audit.events.find((e: Any) => e.action === "auth.denied") as Any;
    assert.ok(!("action" in ev.detail));
  });

  it("a bad token is always 401 invalid-token, never a fallback to the cookie; audited with or without an id", async () => {
    const h = await up(); const { cookie } = await login(h); const { token } = await mint(h, cookie);
    const bad = [`${token}x`, "garbage", "", `plb_${"0".repeat(12)}_${"A".repeat(43)}`];
    for (const t of bad) {
      const r = await raw(h, { path: "/api/v1/whoami", headers: { ...bearer(t), cookie } });
      assert.equal(r.status, 401, t); assert.equal(r.json.reason, "invalid-token");
    }
    const rows = h.audit.events.filter((e: Any) => e.action === "auth.token.used-denied") as Any[];
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((e) => e.actor.user === "anonymous"));
    assert.ok(rows.some((e) => e.target === "token:-"));
  });

  it("a revoked token is denied with its id in the audit trail", async () => {
    const h = await up(); const { cookie } = await login(h); const { token, id } = await mint(h, cookie);
    const rev = await write(h, cookie, { path: "/api/v1/tokens/revoke", body: { id } });
    assert.equal(rev.status, 200);
    const r = await raw(h, { path: "/api/v1/whoami", headers: bearer(token) });
    assert.equal(r.status, 401);
    const ev = h.audit.events.find((e: Any) => e.action === "auth.token.used-denied") as Any;
    assert.equal(ev.target, `token:${id}`); assert.equal(ev.detail.reason, "revoked");
  });

  it("a token of a disabled account is denied (account)", async () => {
    const h = await up(); await addUser(h, { id: "u1", username: "uma", role: "operator" });
    const { cookie } = await loginAs(h, "uma"); const { token } = await mint(h, cookie);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: bearer(token) })).json.principal.id, "u1");
    h.users.change("u1", { disabled: true });
    const r = await raw(h, { path: "/api/v1/whoami", headers: bearer(token) });
    assert.equal(r.status, 401);
    assert.ok(h.audit.events.some((e: Any) => e.action === "auth.token.used-denied" && e.detail.reason === "account"));
  });

  it("only routes with auth 'any' take a token: a session-only route still wants the cookie", async () => {
    const h = await up(); const { cookie } = await login(h); const { token } = await mint(h, cookie);
    const r = await raw(h, { path: "/api/v1/tokens", headers: bearer(token) });
    assert.equal(r.status, 401); assert.equal(r.json.reason, "no-session");
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { authorization: "Basic abc" } })).status, 401);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { authorization: "Bearertoken" } })).status, 401);
  });

  it("an empty 'Bearer' is an invalid token", async () => {
    const h = await up();
    const r = await raw(h, { path: "/api/v1/whoami", headers: { authorization: "Bearer" } });
    assert.equal(r.status, 401); assert.equal(r.json.reason, "invalid-token");
  });
});

describe("rate limiting", () => {
  const limited = { auth: { capacity: 50, refillPerSec: 1 }, read: { capacity: 2, refillPerSec: 0.01 }, write: { capacity: 50, refillPerSec: 1 } };

  it("per IP: 429 with Retry-After and an audit entry, recovering with the clock", async () => {
    const h = await up({ rateClasses: limited });
    const { cookie } = await login(h);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) seen.push((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status);
    assert.deepEqual(seen, [200, 200, 429]);
    const r = await raw(h, { path: "/api/v1/whoami", headers: { cookie } });
    assert.equal(r.status, 429); assert.ok(Number(r.headers["retry-after"]) >= 1); assert.equal(r.json.reason, "rate-limited");
    assert.ok(h.audit.events.some((e: Any) => e.action === "auth.rate-limited" && e.target === "ip:127.0.0.1"));
    h.clock.advance(300_000);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200);
  });

  // A principal (or token) bucket can only trip before the IP bucket when the requests come from different addresses.
  async function from(ip: string, port: number, path: string, headers: Record<string, string>): Promise<number | undefined> {
    const { request } = await import("node:http");
    return new Promise((resolve) => {
      const rq = request({ host: "127.0.0.1", port, localAddress: ip, path, headers, agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      rq.on("error", () => resolve(undefined)); rq.end();
    });
  }

  it("per principal: the same session from other addresses is still limited", async (t) => {
    const h = await up({ rateClasses: limited });
    const { cookie } = await login(h);
    const a = await from("127.0.0.2", h.port, "/api/v1/whoami", { cookie });
    if (a === undefined) { t.skip("no second loopback address on this host"); return; }
    const codes = [a, await from("127.0.0.3", h.port, "/api/v1/whoami", { cookie }), await from("127.0.0.4", h.port, "/api/v1/whoami", { cookie })];
    assert.deepEqual(codes, [200, 200, 429]);
    assert.ok(h.audit.events.some((e: Any) => e.action === "auth.rate-limited" && e.target === "principal:owner"));
  });

  it("per token: the same token from other addresses is still limited", async (t) => {
    const h = await up({ rateClasses: { ...limited, read: { capacity: 3, refillPerSec: 0.01 } } });
    const { cookie } = await login(h);
    const minted = await write(h, cookie, { path: "/api/v1/tokens", body: { name: "ci", scopes: ["agent.*"] } });
    const auth = { authorization: `Bearer ${minted.json.token as string}` };
    const probe = await from("127.0.0.2", h.port, "/api/v1/agents", auth);
    if (probe === undefined) { t.skip("no second loopback address on this host"); return; }
    const codes = [probe];
    for (const ip of ["127.0.0.3", "127.0.0.4", "127.0.0.5"]) codes.push((await from(ip, h.port, "/api/v1/agents", auth)) ?? 0);
    assert.deepEqual(codes, [200, 200, 200, 429]);
    assert.ok(h.audit.events.some((e: Any) => String(e.target).startsWith("token:")));
  });
});

describe("handler outcomes", () => {
  const extraRoutes = [
    { spec: route({ id: "o.status", path: "/api/v1/o/status", successStatus: 201 }), handler: (() => ({ body: { n: 1 } })) as Handler },
    { spec: route({ id: "o.override", path: "/api/v1/o/override" }), handler: (() => ({ status: 202, body: { n: 2 }, headers: { "X-Extra": "1" } })) as Handler },
    { spec: route({ id: "o.apierr", path: "/api/v1/o/apierr" }), handler: (() => { throw new ApiError(409, "E_CONFLICT", "nope", { reason: "taken", headers: { "X-Why": "r" } }); }) as Handler },
    { spec: route({ id: "o.boom", path: "/api/v1/o/boom" }), handler: (() => { throw new Error("secret /etc/passwd detail"); }) as Handler },
    { spec: route({ id: "o.str", path: "/api/v1/o/str" }), handler: (() => { throw "just a string"; }) as Handler },
    { spec: route({ id: "o.async", path: "/api/v1/o/async" }), handler: (async () => { throw new TypeError("async boom"); }) as Handler },
    { spec: route({ id: "o.hang", path: "/api/v1/o/hang" }), handler: (() => new Promise(() => {})) as Handler },
    { spec: route({ id: "o.body", method: "POST", path: "/api/v1/o/body", requestBody: { type: "object" } }), handler: ((i: Any) => ({ body: { echo: i.body } })) as Handler },
  ];

  it("uses the route's success status unless the handler says otherwise and merges handler headers", async () => {
    const h = await up({ extraRoutes });
    const a = await raw(h, { path: "/api/v1/o/status" });
    assert.equal(a.status, 201); assert.deepEqual(a.json, { n: 1 });
    const b = await raw(h, { path: "/api/v1/o/override" });
    assert.equal(b.status, 202); assert.equal(b.headers["x-extra"], "1");
  });

  it("an ApiError becomes its status, reason and headers", async () => {
    const h = await up({ extraRoutes });
    const r = await raw(h, { path: "/api/v1/o/apierr" });
    assert.equal(r.status, 409); assert.equal(r.json.reason, "taken"); assert.equal(r.headers["x-why"], "r");
  });

  it("any other throw is a 500 with a generic body, and the log names it without leaking", async () => {
    const h = await up({ extraRoutes });
    for (const p of ["boom", "str", "async"]) {
      const r = await raw(h, { path: `/api/v1/o/${p}` });
      assert.equal(r.status, 500, p); assert.equal(r.json.error, "E_INTERNAL"); assert.ok(!r.text.includes("/etc/passwd"));
    }
    assert.ok(h.logs.some((l) => l.includes("unhandled error") && l.includes("Error: secret /etc/passwd detail")));
    assert.ok(h.logs.some((l) => l.includes("non-error thrown")));
    assert.ok(h.logs.some((l) => l.includes("TypeError: async boom")));
  });

  it("a handler that never answers is cut off with 504 handler-timeout", async () => {
    const h = await up({ extraRoutes, limits: { handlerTimeoutMs: 1 } });
    const r = await raw(h, { path: "/api/v1/o/hang" });
    assert.equal(r.status, 504); assert.equal(r.json.reason, "handler-timeout");
  });

  it("a request body reaches the handler parsed", async () => {
    const h = await up({ extraRoutes });
    const r = await raw(h, { method: "POST", path: "/api/v1/o/body", headers: jsonHeaders(), body: '{"a":[1,"ü"]}' });
    assert.deepEqual(r.json, { echo: { a: [1, "ü"] } });
  });

  it("logs one 'request' line per request with method, route, status and no credential", async () => {
    const h = await up(); const { cookie } = await login(h);
    await raw(h, { path: "/api/v1/whoami", headers: { cookie } });
    const line = h.logs.map((l) => JSON.parse(l)).filter((l) => l.msg === "request").at(-1);
    assert.equal(line.route, "whoami"); assert.equal(line.status, 200); assert.equal(line.method, "GET"); assert.equal(line.principal, "owner");
    assert.ok(!h.logs.join("\n").includes(OWNER_TOKEN));
    assert.ok(!h.logs.join("\n").includes(cookie.split("=")[1]!));
  });

  it("log fields named like credentials are redacted before they reach the sink", async () => {
    const logs: Array<Record<string, unknown> | undefined> = [];
    const api = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN, logger: { debug() {}, info: (_m, f) => logs.push(f), warn() {}, error() {} }, host: "127.0.0.1" });
    await api.listen(); cleanups.push(() => api.close());
    assert.deepEqual(Object.keys(logs[0]!), ["host", "port", "tls"]);
  });
});

describe("clientError handling", () => {
  function fakeSocket(o: { writable?: boolean; destroyed?: boolean } = {}) {
    const s = { writable: o.writable ?? true, destroyed: o.destroyed ?? false, ended: "" as string, destroyedCalls: 0, end(x: string) { s.ended = x; }, destroy() { s.destroyedCalls++; } };
    return s;
  }
  const cases: Array<[string, string | undefined, number, string]> = [
    ["a request timeout", "ERR_HTTP_REQUEST_TIMEOUT", 408, "request-timeout"],
    ["a header overflow", "HPE_HEADER_OVERFLOW", 431, "headers-too-large"],
    ["a parse error", "HPE_INVALID_METHOD", 400, "malformed-request"],
    ["an error with no code", undefined, 400, "malformed-request"],
  ];
  for (const [label, code, st, reason] of cases) it(`answers ${label} with ${st} and the error/1 body`, async () => {
    const h = await up();
    const sock = fakeSocket();
    h.api.server.emit("clientError", Object.assign(new Error("x"), code ? { code } : {}), sock);
    assert.match(sock.ended, new RegExp(`^HTTP/1\\.1 ${st} `));
    assert.ok(sock.ended.includes("Connection: close"));
    assert.ok(sock.ended.includes("X-Content-Type-Options: nosniff"));
    assert.equal(JSON.parse(sock.ended.slice(sock.ended.indexOf("\r\n\r\n") + 4)).reason, reason);
    assert.ok(h.logs.some((l) => l.includes("malformed request")));
  });

  it("just destroys a socket that is no longer writable or already destroyed", async () => {
    const h = await up();
    const a = fakeSocket({ writable: false }); const b = fakeSocket({ destroyed: true });
    h.api.server.emit("clientError", new Error("x"), a);
    h.api.server.emit("clientError", new Error("x"), b);
    assert.equal(a.destroyedCalls, 1); assert.equal(b.destroyedCalls, 1);
    assert.equal(a.ended, ""); assert.equal(b.ended, "");
  });

  it("real malformed and oversized-header requests get the same documents over the wire", async () => {
    const h = await up({ limits: { maxHeaderBytes: 2048 } });
    assert.equal(status(await exchange(h.port, "NOT HTTP\r\n\r\n")), 400);
    assert.equal(status(await exchange(h.port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nX: ${"a".repeat(4096)}\r\n\r\n`)), 431);
  });
});

describe("break-glass wiring", () => {
  const reason = "needed to fix a support case";

  async function twoUsers(h: Harness) {
    await addUser(h, { id: "a1", username: "adam", role: "admin" }); await addUser(h, { id: "m1", username: "mia", role: "member" });
    return { adam: (await loginAs(h, "adam")).cookie, mia: (await loginAs(h, "mia")).cookie };
  }

  it("a grant is audited, told to the affected user through the inbox and the host hook", async () => {
    const hooked: unknown[] = [];
    const h = await up({ notifyBreakGlass: (n) => { hooked.push(n); } });
    const { adam, mia } = await twoUsers(h);
    const r = await write(h, adam, { path: "/api/v1/breakglass", body: { targetUserId: "m1", reason } });
    assert.equal(r.status, 201, r.text);
    assert.equal(hooked.length, 1);
    const notices = await raw(h, { path: "/api/v1/me/notices", headers: { cookie: mia } });
    assert.equal(notices.json.notices.length, 1); assert.equal(notices.json.notices[0].holderUserId, "a1");
    assert.ok(h.audit.events.some((e: Any) => e.action === "break-glass.granted"));
  });

  it("works without a host hook, and a throwing hook does not undo the grant", async () => {
    const plain = await up(); const p = await twoUsers(plain);
    assert.equal((await write(plain, p.adam, { path: "/api/v1/breakglass", body: { targetUserId: "m1", reason } })).status, 201);
    const throwing = await up({ notifyBreakGlass: () => { throw new Error("mail down"); } }); const t = await twoUsers(throwing);
    assert.equal((await write(throwing, t.adam, { path: "/api/v1/breakglass", body: { targetUserId: "m1", reason } })).status, 201);
  });

  it("the break-glass sink is the dedicated one when given, else the shared audit, else there is no break-glass", async () => {
    const own = memoryAuditSink();
    const a = await up({ breakGlassAudit: own }); const ua = await twoUsers(a);
    assert.equal((await write(a, ua.adam, { path: "/api/v1/breakglass", body: { targetUserId: "m1", reason } })).status, 201);
    assert.ok(own.events.some((e: Any) => e.action === "break-glass.granted"));
    assert.ok(!a.audit.events.some((e: Any) => e.action === "break-glass.granted"));

    const shared = await up(); const us = await twoUsers(shared);
    assert.equal((await write(shared, us.adam, { path: "/api/v1/breakglass", body: { targetUserId: "m1", reason } })).status, 201);
    assert.ok(shared.audit.events.some((e: Any) => e.action === "break-glass.granted"));

    const none = await up({ noAudit: true }); const un = await twoUsers(none);
    const r = await write(none, un.adam, { path: "/api/v1/breakglass", body: { targetUserId: "m1", reason } });
    assert.equal(r.status, 503); assert.equal(r.json.reason, "audit-unavailable");
  });
});

describe("options", () => {
  it("without a user directory only the owner token logs in", async () => {
    const api = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN });
    const { url } = await api.listen(); cleanups.push(() => api.close());
    const port = Number(new URL(url).port);
    const h = { port } as Harness;
    const pw = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "a", password: "b" }) });
    assert.equal(pw.status, 401);
    const owner = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: OWNER_TOKEN }) });
    assert.equal(owner.status, 200);
  });

  it("accepts a custom token store, totp store, issuer, lockout and session limits", async () => {
    const users = new MemoryUserDirectory();
    const api = createApiServer({
      core: fakeCore(), ownerToken: OWNER_TOKEN, users, totpIssuer: "Test", lockout: { maxFailures: 1 }, sessionLimits: { idleMs: 1000, absoluteMs: 2000, maxSessions: 1, csrfTtlMs: 1000, maxCsrfPerSession: 1 },
      limits: { keepAliveTimeoutMs: 1000, requestTimeoutMs: 2000, headersTimeoutMs: 5000 },
    });
    const { url } = await api.listen(); cleanups.push(() => api.close());
    const h = { port: Number(new URL(url).port) } as Harness;
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: OWNER_TOKEN }) })).status, 200);
  });
});

describe("TLS listener", () => {
  it("HTTPS: HSTS, __Host- Secure cookie, https origin", async (t) => {
    const dir = tmp("api-srv-tls-");
    const gen = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    if (gen.status !== 0) { t.skip("openssl is not available"); return; }
    const api = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN, tls: { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) } });
    const { port, url } = await api.listen(); cleanups.push(() => api.close());
    assert.equal(url, `https://127.0.0.1:${port}`);
    const res = await new Promise<{ headers: Record<string, any>; status: number }>((resolve, reject) => {
      const rq = https.request({ host: "127.0.0.1", port, method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), origin: url }, rejectUnauthorized: false, agent: false }, (r) => { r.resume(); r.on("end", () => resolve({ headers: r.headers, status: r.statusCode ?? 0 })); });
      rq.on("error", reject); rq.end(JSON.stringify({ token: OWNER_TOKEN }));
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["strict-transport-security"], /max-age=\d+/);
    assert.match(res.headers["set-cookie"][0], /^__Host-plur1bus_session=.*; Secure/);
  });
});
