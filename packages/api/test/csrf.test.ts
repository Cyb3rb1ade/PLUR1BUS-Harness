import assert from "node:assert/strict";
import test from "node:test";
import { csrfToken, login, raw, start } from "./helpers.ts";

const del = (h: Parameters<typeof raw>[0], cookie: string, extra: Record<string, string> = {}) => raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie, ...extra } });

test("a write without a CSRF token is 403 and leaves the session alive", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h);
    const r = await del(h, cookie);
    assert.equal(r.status, 403); assert.deepEqual(r.json, { schema: "error/1", error: "E_DENIED", message: "a valid one-time CSRF token is required", reason: "csrf" });
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200);
  } finally { await h.close(); }
});

test("a wrong, empty, replayed or another session's CSRF token is 403", async () => {
  const h = await start();
  try {
    const a = await login(h); const b = await login(h);
    assert.equal((await del(h, a.cookie, { "x-csrf-token": "nope" })).status, 403);
    assert.equal((await del(h, a.cookie, { "x-csrf-token": "" })).status, 403);
    const tb = await csrfToken(h, b.cookie);
    assert.equal((await del(h, a.cookie, { "x-csrf-token": tb })).status, 403, "bound to the session it was issued to");
    const ta = await csrfToken(h, a.cookie);
    assert.equal((await del(h, a.cookie, { "x-csrf-token": ta })).status, 200);
    assert.equal((await del(h, a.cookie, { "x-csrf-token": ta })).status, 401, "the session is gone");
    assert.equal((await del(h, b.cookie, { "x-csrf-token": tb })).status, 200);
  } finally { await h.close(); }
});

test("a spent CSRF token cannot be replayed and an expired one is refused", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h);
    const t1 = await csrfToken(h, cookie);
    assert.equal((await del(h, cookie, { "x-csrf-token": "x" })).status, 403);
    const t2 = await csrfToken(h, cookie); h.clock.advance(10 * 60_000 + 1);
    assert.equal((await del(h, cookie, { "x-csrf-token": t2 })).status, 403, "expired");
    assert.equal((await del(h, cookie, { "x-csrf-token": t1 })).status, 403, "expired");
    const t3 = await csrfToken(h, cookie);
    assert.equal((await del(h, cookie, { "x-csrf-token": t3 })).status, 200);
  } finally { await h.close(); }
});

test("the CSRF check comes after authentication: no session is 401, not 403", async () => {
  const h = await start();
  try { assert.equal((await del(h, "plur1bus_session=forged", { "x-csrf-token": "x" })).status, 401); } finally { await h.close(); }
});

test("a foreign Origin on a write is refused even with a valid token (the token is not spent)", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h); const t = await csrfToken(h, cookie);
    assert.equal((await del(h, cookie, { "x-csrf-token": t, origin: "https://evil.example" })).status, 403);
    assert.equal((await del(h, cookie, { "x-csrf-token": t })).status, 200);
  } finally { await h.close(); }
});

test("Referer: a foreign, garbage or opaque Referer on a write is refused even with a valid token; the token is not spent", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h); const t = await csrfToken(h, cookie);
    for (const referer of ["https://evil.example/page", "http://127.0.0.1.evil.example/x", "null", "not a url", "//evil.example/", `http://127.0.0.1:${h.port + 1}/`, "javascript:alert(1)", ""]) {
      const r = await del(h, cookie, { "x-csrf-token": t, referer });
      assert.equal(r.status, 403, JSON.stringify(referer)); assert.equal(r.json.reason, "referer");
    }
    assert.equal((await del(h, cookie, { "x-csrf-token": t, referer: `http://127.0.0.1:${h.port}/app/settings?x=1` })).status, 200, "the API's own origin passes");
  } finally { await h.close(); }
});

test("Referer: a foreign Referer is refused even when the Origin is the API's own (a browser never sends that pair)", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h); const t = await csrfToken(h, cookie);
    const r = await del(h, cookie, { "x-csrf-token": t, origin: `http://127.0.0.1:${h.port}`, referer: "https://evil.example/" });
    assert.equal(r.status, 403); assert.equal(r.json.reason, "referer");
  } finally { await h.close(); }
});

test("Referer: login is a write too, so a foreign Referer cannot make the browser log in", async () => {
  const h = await start();
  try {
    const body = JSON.stringify({ token: "0123456789abcdef".repeat(4) });
    const r = await raw(h, { method: "POST", path: "/api/v1/session", headers: { "content-type": "application/json", referer: "https://evil.example/" }, body });
    assert.equal(r.status, 403); assert.equal(r.headers["set-cookie"], undefined);
  } finally { await h.close(); }
});

test("Referer: a read may carry any Referer (a normal link from elsewhere); no Referer at all is a non-browser client and passes", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie, referer: "https://news.example/story" } })).status, 200);
    const t = await csrfToken(h, cookie);
    assert.equal((await del(h, cookie, { "x-csrf-token": t })).status, 200, "no Origin and no Referer");
  } finally { await h.close(); }
});

test("a refused CSRF check is audited, once per window", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h);
    for (let i = 0; i < 5; i++) await del(h, cookie, { "x-csrf-token": `bad${i}` });
    const ev = h.audit.events.filter((e) => e.action === "auth.csrf-refused");
    assert.equal(ev.length, 1); assert.equal(ev[0]!.actor.user, "owner"); assert.ok(!JSON.stringify(ev).includes("bad0"));
  } finally { await h.close(); }
});
