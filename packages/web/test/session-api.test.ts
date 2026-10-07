import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { HttpSessionApi } from "../src/session.ts";
import { cookieFetch, MockHarnessServer, OWNER_TOKEN } from "./mock-server.ts";

let dist = "";
before(async () => { dist = await mkdtemp(join(tmpdir(), "p1web-api-")); });
after(async () => { await rm(dist, { recursive: true, force: true }); });

async function withServer(run: (s: MockHarnessServer, base: string) => Promise<void>, opts: { maxFailures?: number } = {}): Promise<void> {
  const s = new MockHarnessServer({ distDir: dist, ...opts });
  const base = await s.start();
  try { await run(s, base); } finally { await s.stop(); }
}

const owner = { id: "owner", role: "owner" };

test("login posts the token to /api/v1/session, whoami then answers the principal, the token is in no URL", async () => {
  await withServer(async (s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    assert.equal(await api.whoami(), null);
    assert.deepEqual(await api.login({ token: OWNER_TOKEN }), { ok: true, user: owner });
    assert.deepEqual(await api.whoami(), owner);
    const login = s.requests.find((q) => q.method === "POST" && q.url === "/api/v1/session");
    assert.deepEqual(JSON.parse(login!.body), { token: OWNER_TOKEN });
    for (const q of s.requests) assert.ok(!q.url.includes(OWNER_TOKEN), q.url);
  });
});

test("a wrong token is invalid-token and creates no session", async () => {
  await withServer(async (s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    assert.deepEqual(await api.login({ token: "x".repeat(40) }), { ok: false, failure: { kind: "invalid-token" } });
    assert.equal(s.sessions.size, 0);
  });
});

test("429 carries Retry-After into the failure", async () => {
  await withServer(async (_s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    for (let i = 0; i < 2; i++) await api.login({ token: "x".repeat(40) });
    assert.deepEqual(await api.login({ token: OWNER_TOKEN }), { ok: false, failure: { kind: "rate-limited", retryAfterSeconds: 30 } });
  }, { maxFailures: 2 });
});

test("network failure, server error and malformed success are distinct failures", async () => {
  const down = new HttpSessionApi("http://127.0.0.1:1", fetch);
  assert.deepEqual(await down.login({ token: OWNER_TOKEN }), { ok: false, failure: { kind: "network" } });
  await withServer(async (s, base) => {
    s.forceStatus = 503;
    assert.deepEqual(await new HttpSessionApi(base, cookieFetch()).login({ token: OWNER_TOKEN }), { ok: false, failure: { kind: "server", status: 503 } });
    await assert.rejects(new HttpSessionApi(base, cookieFetch()).whoami());
  });
  const garbage: typeof fetch = async () => new Response("{\"principal\":1}", { status: 200, headers: { "content-type": "application/json" } });
  assert.deepEqual(await new HttpSessionApi("", garbage).login({ token: OWNER_TOKEN }), { ok: false, failure: { kind: "server", status: 200 } });
});

test("logout fetches a one-time CSRF token, sends it on DELETE /api/v1/session and ends the session", async () => {
  await withServer(async (s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    await api.login({ token: OWNER_TOKEN });
    await api.logout();
    const reqs = s.requests.map((q) => `${q.method} ${q.url}`);
    assert.deepEqual(reqs.slice(-2), ["GET /api/v1/csrf", "DELETE /api/v1/session"]);
    assert.ok(s.requests.at(-1)!.csrf, "the DELETE carries X-CSRF-Token");
    assert.equal(s.sessions.size, 0);
    assert.equal(await api.whoami(), null);
  });
  await new HttpSessionApi("http://127.0.0.1:1", fetch).logout(); // never throws
});

test("every mutating request gets a fresh CSRF token (they are one-time)", async () => {
  await withServer(async (s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    await api.login({ token: OWNER_TOKEN });
    const a = await api.write("DELETE", "/api/v1/session");
    assert.deepEqual(a, { ok: true, status: 200, body: { schema: "session.delete/1", ok: true } });
    await api.login({ token: OWNER_TOKEN });
    await api.write("DELETE", "/api/v1/session");
    const tokens = s.requests.filter((q) => q.method === "DELETE").map((q) => q.csrf);
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
  });
});

test("a refused CSRF token is retried once with a fresh one; a second refusal is a csrf failure", async () => {
  await withServer(async (s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    await api.login({ token: OWNER_TOKEN });
    s.rejectCsrf = 1;
    assert.equal((await api.write("DELETE", "/api/v1/session")).ok, true);
    await api.login({ token: OWNER_TOKEN });
    s.rejectCsrf = 2;
    assert.deepEqual(await api.write("DELETE", "/api/v1/session"), { ok: false, failure: { kind: "csrf" } });
    assert.equal(s.sessions.size, 1, "the session survives a refused write");
  });
});

test("an expired session surfaces as session-expired, on whoami as null and on a write as a failure", async () => {
  await withServer(async (s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    await api.login({ token: OWNER_TOKEN });
    s.expireAll();
    assert.deepEqual(await api.write("DELETE", "/api/v1/session"), { ok: false, failure: { kind: "session-expired" } });
    assert.equal(await api.whoami(), null);
  });
});

test("the token is never kept in storage, logged or put in a header other than the login body", async () => {
  const seen: string[] = [];
  const spy: typeof fetch = async (input, init) => {
    seen.push(String(input), JSON.stringify(init?.headers ?? {}));
    return new Response("{}", { status: 401 });
  };
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    const api = new HttpSessionApi("", spy);
    await api.login({ token: OWNER_TOKEN });
    await api.whoami();
    await api.logout();
  } finally { Object.assign(console, orig); }
  for (const x of [...seen, ...logged]) assert.ok(!x.includes(OWNER_TOKEN), x);
});
