import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { API_ROUTES, createApi, isApiError, type Api, type ApiError } from "../src/api/index.ts";
import { HttpSessionApi } from "../src/session.ts";
import { cookieFetch, MockHarnessServer, OWNER_TOKEN } from "./mock-server.ts";
import { rpcError } from "./mock-rpc.ts";

type Ctx = { s: MockHarnessServer; base: string; api: Api; fetch: typeof fetch; unauth: string[] };

async function withApi(run: (c: Ctx) => Promise<void>, opts: { login?: boolean } = {}): Promise<void> {
  const s = new MockHarnessServer({ distDir: tmpdir() });
  const base = await s.start();
  try {
    const f = cookieFetch();
    if (opts.login !== false) await new HttpSessionApi(base, f).login({ token: OWNER_TOKEN });
    const unauth: string[] = [];
    const api = createApi({ baseUrl: base, fetch: f, onUnauthenticated: (k) => { unauth.push(k); } });
    await run({ s, base, api, fetch: f, unauth });
  } finally { await s.stop(); }
}

async function failureOf(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { assert.ok(isApiError(e), `not an ApiError: ${String(e)}`); return e; }
  throw new Error("expected a failure");
}

test("the routes are one table", () => {
  assert.equal(API_ROUTES.rpc, "/rpc");
  assert.equal(API_ROUTES.events, "/events");
});

test("rpc: success sends a JSON-RPC 2.0 request with the session cookie and a fresh CSRF token", async () => {
  await withApi(async ({ s, api }) => {
    s.rpc.handle("dreams.status", (params) => ({ echo: params }));
    assert.deepEqual(await api.rpc("dreams.status", { a: 1 }), { echo: { a: 1 } });
    const req = s.requests.find((q) => q.url === "/rpc")!;
    assert.equal(req.method, "POST");
    assert.ok(req.hasCookie);
    assert.ok(req.csrf);
    const wire = JSON.parse(req.body) as Record<string, unknown>;
    assert.equal(wire.jsonrpc, "2.0");
    assert.equal(wire.method, "dreams.status");
    assert.deepEqual(wire.params, { a: 1 });
    assert.deepEqual(s.requests.slice(-2).map((q) => `${q.method} ${q.url}`), ["GET /api/v1/csrf", "POST /rpc"]);
  });
});

test("rpc: every write call fetches its own one-time token; { write: false } sends none", async () => {
  await withApi(async ({ s, api }) => {
    s.rpc.handle("a.write", () => 1);
    s.rpc.handle("a.read", () => 2, { write: false });
    await api.rpc("a.write");
    await api.rpc("a.write");
    const writes = s.requests.filter((q) => q.url === "/rpc").map((q) => q.csrf);
    assert.equal(writes.length, 2);
    assert.notEqual(writes[0], writes[1]);
    const before = s.requests.length;
    assert.equal(await api.rpc("a.read", undefined, { write: false }), 2);
    const sent = s.requests.slice(before);
    assert.deepEqual(sent.map((q) => q.url), ["/rpc"]);
    assert.equal(sent[0]!.csrf, null);
  });
});

test("rpc: JSON-RPC errors become rpc-error with code, message, data, errorCode and reason", async () => {
  await withApi(async ({ s, api }) => {
    s.rpc.handle("dreams.run", () => { throw rpcError("E_CONFLICT", "busy", "turn-running"); });
    const e = await failureOf(api.rpc("dreams.run"));
    assert.equal(e.kind, "rpc-error");
    if (e.kind !== "rpc-error") return;
    assert.equal(e.code, -32000);
    assert.equal(e.message, "busy");
    assert.equal(e.errorCode, "E_CONFLICT");
    assert.equal(e.reason, "turn-running");
    assert.deepEqual(e.data, { error: "E_CONFLICT", reason: "turn-running" });
    const nf = await failureOf(api.rpc("nope.nothing"));
    assert.equal(nf.kind, "rpc-error");
    if (nf.kind === "rpc-error") assert.equal(nf.code, -32601);
  });
});

test("rpc: E_DENIED is forbidden, E_NOT_AVAILABLE and E_CORE_UNAVAILABLE are unavailable (with reason), E_UNAUTHORIZED is unauthenticated", async () => {
  await withApi(async ({ s, api, unauth }) => {
    s.rpc.handle("m.x", () => 1);
    s.rpc.scenario("m.x", "forbidden");
    assert.equal((await failureOf(api.rpc("m.x"))).kind, "forbidden");
    s.rpc.scenario("m.x", "unavailable");
    const u = await failureOf(api.rpc("m.x"));
    assert.equal(u.kind, "unavailable");
    if (u.kind === "unavailable") assert.equal(u.reason, "mock-unavailable");
    s.rpc.scenario("m.x", "error", { code: "E_CORE_UNAVAILABLE", reason: "core-unreachable" });
    const c = await failureOf(api.rpc("m.x"));
    assert.equal(c.kind, "unavailable");
    if (c.kind === "unavailable") assert.equal(c.reason, "core-unreachable");
    s.rpc.scenario("m.x", "error", { code: "E_UNAUTHORIZED" });
    assert.equal((await failureOf(api.rpc("m.x"))).kind, "unauthenticated");
    assert.ok(unauth.length >= 1);
    s.rpc.scenario("m.x", "empty");
    assert.equal(await api.rpc("m.x"), null);
  });
});

test("an absent backend (404, 405, 501, 503, network failure) is unavailable and keeps its reason", async () => {
  await withApi(async ({ s, api }) => {
    const e = await failureOf(api.rpc("dreams.status")); // /rpc is not enabled: 404
    assert.equal(e.kind, "unavailable");
    if (e.kind === "unavailable") { assert.equal(e.status, 404); assert.equal(e.reason, "route"); }
    s.forceStatus = 503;
    const rest = await failureOf(api.get("/api/v1/agents"));
    assert.equal(rest.kind, "unavailable");
    if (rest.kind === "unavailable") assert.equal(rest.status, 503);
  });
  for (const status of [404, 405, 501, 503]) {
    const api = createApi({ fetch: async () => new Response("<html>nope</html>", { status, headers: { "content-type": "text/html" } }), csrf: async () => "t" });
    const e = await failureOf(api.get("/x"));
    assert.equal(e.kind, "unavailable", String(status));
    assert.equal((await failureOf(api.rpc("m.x"))).kind, "unavailable", String(status));
  }
  const down = createApi({ baseUrl: "http://127.0.0.1:1" });
  const n = await failureOf(down.get("/api/v1/health"));
  assert.equal(n.kind, "unavailable");
  if (n.kind === "unavailable") assert.equal(n.reason, "network");
  const w = await failureOf(down.rpc("m.x"));
  assert.equal(w.kind, "unavailable");
});

test("without a session: reads are unauthenticated, writes are session-expired, and the callback hears both", async () => {
  await withApi(async ({ s, api, unauth }) => {
    s.rpc.handle("m.read", () => 1, { write: false });
    s.rpc.handle("m.write", () => 1);
    assert.equal((await failureOf(api.get("/api/v1/whoami"))).kind, "unauthenticated");
    assert.equal((await failureOf(api.rpc("m.read", undefined, { write: false }))).kind, "unauthenticated");
    assert.equal((await failureOf(api.rpc("m.write"))).kind, "session-expired");
    assert.equal((await failureOf(api.post("/api/v1/anything", { a: 1 }))).kind, "session-expired");
    assert.deepEqual(unauth, ["unauthenticated", "unauthenticated", "session-expired", "session-expired"]);
  }, { login: false });
  await withApi(async ({ s, api }) => {
    s.rpc.handle("m.write", () => 1);
    s.expireAll();
    assert.equal((await failureOf(api.rpc("m.write"))).kind, "session-expired");
  });
});

test("a refused CSRF token is retried once with a fresh one; a second refusal is a csrf error", async () => {
  await withApi(async ({ s, api }) => {
    s.rpc.handle("m.write", () => "ok");
    s.rejectCsrf = 1;
    assert.equal(await api.rpc("m.write"), "ok");
    const tokens = s.requests.filter((q) => q.url === "/rpc").map((q) => q.csrf);
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
    s.rejectCsrf = 2;
    assert.equal((await failureOf(api.rpc("m.write"))).kind, "csrf");
    assert.equal(s.requests.filter((q) => q.url === "/rpc").length, 4, "no third attempt");
    assert.equal(s.sessions.size, 1);
  });
});

test("a read that the server treats as a write is upgraded: 403 csrf then one retry with a token", async () => {
  await withApi(async ({ s, api }) => {
    s.rpc.handle("m.sneaky", () => "ok"); // write by default on the server
    assert.equal(await api.rpc("m.sneaky", undefined, { write: false }), "ok");
    const posts = s.requests.filter((q) => q.url === "/rpc");
    assert.equal(posts[0]!.csrf, null);
    assert.ok(posts[1]!.csrf);
  });
});

test("abort in the middle of a call rejects with aborted; an already-aborted signal sends nothing", async () => {
  await withApi(async ({ s, api }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let arrived: () => void = () => {};
    const seen = new Promise<void>((r) => { arrived = r; });
    s.rpc.handle("m.slow", async () => { arrived(); await gate; return 1; });
    const ac = new AbortController();
    const p = failureOf(api.rpc("m.slow", undefined, { signal: ac.signal }));
    await seen;
    ac.abort();
    assert.equal((await p).kind, "aborted");
    release();
    const before = s.requests.length;
    assert.equal((await failureOf(api.rpc("m.slow", undefined, { signal: AbortSignal.abort() }))).kind, "aborted");
    assert.equal((await failureOf(api.get("/api/v1/whoami", { signal: AbortSignal.abort() }))).kind, "aborted");
    assert.equal(s.requests.length, before);
  });
});

test("REST: get, post and delete carry cookie and CSRF as the session surface does", async () => {
  await withApi(async ({ s, api }) => {
    const who = (await api.get("/api/v1/whoami")) as { principal: { id: string } };
    assert.equal(who.principal.id, "owner");
    assert.equal(s.requests.at(-1)!.csrf, null);
    const gone = await api.delete("/api/v1/session");
    assert.deepEqual(gone, { schema: "session.delete/1", ok: true });
    assert.ok(s.requests.at(-1)!.csrf);
    assert.equal(s.sessions.size, 0);
  });
  await withApi(async ({ api }) => {
    const e = await failureOf(api.post("/api/v1/nowhere", { x: 1 }));
    assert.equal(e.kind, "unavailable"); // 404
  });
});

test("REST: 403 without a csrf reason is forbidden, 429 keeps Retry-After, other statuses are http errors", async () => {
  const mk = (status: number, body: unknown, headers: Record<string, string> = {}): Api =>
    createApi({ csrf: async () => "t", fetch: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }) });
  assert.equal((await failureOf(mk(403, { error: "E_DENIED", reason: "role" }).get("/x"))).kind, "forbidden");
  const r = await failureOf(mk(429, { error: "E_DENIED", reason: "rate-limited" }, { "retry-after": "7" }).get("/x"));
  assert.equal(r.kind, "http");
  if (r.kind === "http") { assert.equal(r.status, 429); assert.equal(r.retryAfterSeconds, 7); }
  const b = await failureOf(mk(400, { error: "E_INVALID_PARAMS", reason: "body" }).get("/x"));
  assert.equal(b.kind, "http");
  if (b.kind === "http") { assert.equal(b.status, 400); assert.equal(b.reason, "body"); assert.equal(b.errorCode, "E_INVALID_PARAMS"); }
  const empty = createApi({ csrf: async () => "t", fetch: async () => new Response(null, { status: 204 }) });
  assert.equal(await empty.delete("/x"), null);
});

test("neither the CSRF token nor the cookie shows up in a failure's message", async () => {
  await withApi(async ({ s, api }) => {
    s.rpc.handle("m.x", () => { throw rpcError("E_INTERNAL", "boom"); });
    const e = await failureOf(api.rpc("m.x"));
    const csrf = s.requests.find((q) => q.url === "/rpc")!.csrf!;
    assert.ok(!JSON.stringify({ m: e.message, k: e.kind }).includes(csrf));
  });
});
