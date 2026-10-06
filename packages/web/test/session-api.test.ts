import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { HttpSessionApi } from "../src/session.ts";
import { cookieFetch, MockHarnessServer } from "./mock-server.ts";

let dist = "";
before(async () => { dist = await mkdtemp(join(tmpdir(), "p1web-api-")); });
after(async () => { await rm(dist, { recursive: true, force: true }); });

async function withServer(run: (s: MockHarnessServer, base: string) => Promise<void>, opts: { maxFailures?: number } = {}): Promise<void> {
  const s = new MockHarnessServer({ distDir: dist, ...opts });
  const base = await s.start();
  try { await run(s, base); } finally { await s.stop(); }
}

const good = { username: "alice", password: "correct horse battery" };

test("login succeeds, whoami then returns the same user, and the password never appears in a URL", async () => {
  await withServer(async (s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    assert.equal(await api.whoami(), null);
    const r = await api.login(good);
    assert.deepEqual(r, { ok: true, user: { userId: "alice", displayName: "Alice", role: "owner" } });
    assert.deepEqual(await api.whoami(), { userId: "alice", displayName: "Alice", role: "owner" });
    for (const q of s.requests) assert.ok(!q.url.includes("correct"), q.url);
  });
});

test("wrong credentials are reported as invalid-credentials and create no session", async () => {
  await withServer(async (s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    assert.deepEqual(await api.login({ username: "alice", password: "nope" }), { ok: false, failure: { kind: "invalid-credentials" } });
    assert.equal(s.sessions.size, 0);
  });
});

test("429 carries Retry-After into the failure", async () => {
  await withServer(async (_s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    for (let i = 0; i < 2; i++) await api.login({ username: "alice", password: "nope" });
    assert.deepEqual(await api.login(good), { ok: false, failure: { kind: "rate-limited", retryAfterSeconds: 30 } });
  }, { maxFailures: 2 });
});

test("network failure, server error and malformed success are distinct failures", async () => {
  const down = new HttpSessionApi("http://127.0.0.1:1", fetch);
  assert.deepEqual(await down.login(good), { ok: false, failure: { kind: "network" } });
  await withServer(async (s, base) => {
    s.forceStatus = 503;
    assert.deepEqual(await new HttpSessionApi(base, cookieFetch()).login(good), { ok: false, failure: { kind: "server", status: 503 } });
    await assert.rejects(new HttpSessionApi(base, cookieFetch()).whoami());
  });
  const garbage: typeof fetch = async () => new Response("{\"userId\":1}", { status: 200, headers: { "content-type": "application/json" } });
  assert.deepEqual(await new HttpSessionApi("", garbage).login(good), { ok: false, failure: { kind: "server", status: 200 } });
});

test("logout sends the CSRF token, ends the session server-side and never throws", async () => {
  await withServer(async (s, base) => {
    const api = new HttpSessionApi(base, cookieFetch());
    await api.login(good);
    const csrf = [...s.sessions.values()][0]!.csrf;
    await api.logout();
    const post = s.requests.filter((q) => q.url === "/api/v1/auth/logout").at(-1);
    assert.equal(post?.csrf, csrf);
    assert.equal(s.sessions.size, 0);
    assert.equal(await api.whoami(), null);
  });
  await new HttpSessionApi("http://127.0.0.1:1", fetch).logout();
});

test("logout without the CSRF token is refused by the mock (so the client must send it)", async () => {
  await withServer(async (s, base) => {
    const f = cookieFetch();
    await new HttpSessionApi(base, f).login(good);
    const res = await f(base + "/api/v1/auth/logout", { method: "POST" });
    assert.equal(res.status, 403);
    assert.equal(s.sessions.size, 1);
  });
});
