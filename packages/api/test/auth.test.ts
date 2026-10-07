import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RATE_CLASSES } from "../src/rate-limit.ts";
import { ROUTES } from "../src/routes.ts";
import { jsonHeaders, login, OWNER_TOKEN, raw, start } from "./helpers.ts";

test("every route that is not public answers 401 without a session (deny by default)", async () => {
  const h = await start();
  try {
    for (const r of ROUTES.filter((x) => x.auth !== "none")) {
      const res = await raw(h, { method: r.method, path: r.path, headers: jsonHeaders() });
      assert.equal(res.status, 401, `${r.method} ${r.path}`);
      assert.deepEqual(res.json, { schema: "error/1", error: "E_UNAUTHORIZED", message: "authentication required", reason: "no-session" });
    }
    assert.equal(h.core.calls.length, 0, "no unauthenticated request reaches the core");
  } finally { await h.close(); }
});

test("a forged, empty or foreign-prefixed cookie is not a session; a Bearer header is not a way in", async () => {
  const h = await start();
  try {
    for (const headers of [{ cookie: "plur1bus_session=forged" }, { cookie: "plur1bus_session=" }, { cookie: "__Host-plur1bus_session=x" }, { authorization: `Bearer ${OWNER_TOKEN}` }, { authorization: `Basic ${Buffer.from(`owner:${OWNER_TOKEN}`).toString("base64")}` }]) {
      assert.equal((await raw(h, { path: "/api/v1/whoami", headers })).status, 401, JSON.stringify(Object.keys(headers)));
    }
  } finally { await h.close(); }
});

test("login with the owner token sets an HttpOnly, SameSite=Strict, Path=/ cookie (no Secure over plain loopback HTTP)", async () => {
  const h = await start();
  try {
    const { cookie, res } = await login(h);
    assert.equal(res.status, 200);
    assert.equal(res.json.schema, "session.create/1"); assert.deepEqual(res.json.principal, { kind: "owner", id: "owner", role: "owner" });
    const set = res.headers["set-cookie"]![0]!;
    assert.match(set, /^plur1bus_session=[A-Za-z0-9_-]{43};/); assert.match(set, /; HttpOnly/); assert.match(set, /; SameSite=Strict/); assert.match(set, /; Path=\//); assert.match(set, /; Max-Age=43200/); assert.doesNotMatch(set, /Secure/);
    const who = await raw(h, { path: "/api/v1/whoami", headers: { cookie } });
    assert.equal(who.status, 200); assert.equal(who.json.schema, "whoami/1"); assert.equal(who.json.principal.id, "owner");
  } finally { await h.close(); }
});

test("a wrong, missing or malformed login is refused, never a session; the core's RPC token shape is no credential", async () => {
  const h = await start({ rateClasses: { ...DEFAULT_RATE_CLASSES, auth: { capacity: 100, refillPerSec: 1 } } });
  try {
    for (const body of [{ token: "b".repeat(64) }, { token: "" }, { token: OWNER_TOKEN.slice(1) }, { token: 5 }, {}, { token: OWNER_TOKEN, extra: 1 }, [OWNER_TOKEN], null]) {
      const r = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify(body) });
      assert.ok(r.status === 401 || r.status === 400, `${JSON.stringify(body)} -> ${r.status}`);
      assert.equal(r.headers["set-cookie"], undefined);
    }
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: "{not json" })).json.reason, "json");
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: { "content-type": "text/plain" }, body: OWNER_TOKEN })).status, 415);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: "b".repeat(64) }) })).json.reason, "invalid-token");
  } finally { await h.close(); }
});

test("a session expires on the idle timer and on the absolute limit", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h);
    h.clock.advance(29 * 60_000); assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200);
    h.clock.advance(29 * 60_000); assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200);
    h.clock.advance(31 * 60_000); assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 401);
  } finally { await h.close(); }
});

test("login does not need an existing session, but a cross-origin page cannot make the browser do it", async () => {
  const h = await start();
  try {
    const hdr = jsonHeaders();
    const body = JSON.stringify({ token: OWNER_TOKEN });
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...hdr, origin: "https://evil.example" }, body })).status, 403);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...hdr, "sec-fetch-site": "cross-site" }, body })).status, 403);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...hdr, "sec-fetch-site": "same-site" }, body })).status, 403, "another local app on localhost is same-site, not same-origin");
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...hdr, origin: `http://127.0.0.1:${h.port}`, "sec-fetch-site": "same-origin" }, body })).status, 200);
  } finally { await h.close(); }
});

test("a Host header that is not the API's own loopback name is refused (DNS rebinding)", async () => {
  const h = await start();
  try {
    for (const host of ["evil.example", `evil.example:${h.port}`, "127.0.0.1", `127.0.0.1:${h.port + 1}`, "0.0.0.0:" + h.port]) {
      const r = await raw(h, { path: "/api/v1/health", headers: { host } });
      assert.equal(r.status, 421, host); assert.equal(r.json.reason, "host");
    }
    assert.equal((await raw(h, { path: "/api/v1/health", headers: { host: `localhost:${h.port}` } })).status, 401);
  } finally { await h.close(); }
});

test("logout ends the session on the server and clears the cookie", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h);
    const t = (await raw(h, { path: "/api/v1/csrf", headers: { cookie } })).json.token;
    const out = await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie, "x-csrf-token": t } });
    assert.equal(out.status, 200); assert.match(out.headers["set-cookie"]![0]!, /Max-Age=0/);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 401, "the old cookie is dead even if the browser keeps it");
  } finally { await h.close(); }
});
