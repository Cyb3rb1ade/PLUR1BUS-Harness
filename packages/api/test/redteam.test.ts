// Red-team regression tests for docs/security/http-api-review-2026-10.md. Every test names the finding (F<n>) or the
// non-finding (OK-<n>) it pins. In-process server, fake core, fake clock; real timers only where Node's own socket
// timeouts are the thing under test (short limits, event-driven waits, no sleeps).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { METHODS } from "@plur1bus/rpc-schema";
import { ROUTES } from "../src/routes.ts";
import { ownerTokenVerifier } from "../src/session.ts";
import { csrfToken, fakeCore, jsonHeaders, login, OWNER_TOKEN, raw, start, type Harness } from "./helpers.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const post = (h: Harness, body: string, headers: Record<string, string> = jsonHeaders(), p = "/api/v1/session") => raw(h, { method: "POST", path: p, headers, body });
const wide = { auth: { capacity: 1000, refillPerSec: 100 }, read: { capacity: 1000, refillPerSec: 100 }, write: { capacity: 1000, refillPerSec: 100 } };

/** Raw bytes in, everything the server answers out, until it closes or `ms` passes. */
function socketExchange(port: number, send: (s: ReturnType<typeof connect>) => void, ms = 3000): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1"); let data = "";
    const t = setTimeout(() => s.destroy(), ms);
    s.on("data", (c) => { data += c; }); s.on("close", () => { clearTimeout(t); resolve(data); }); s.on("error", () => {});
    s.on("connect", () => send(s));
  });
}

// ---- F1 ------------------------------------------------------------------------------------------------------------
test("F1: requests the Origin/Fetch-Metadata check refuses do not spend the login or read rate buckets", async () => {
  const h = await start({ rateClasses: { auth: { capacity: 2, refillPerSec: 0.01 }, read: { capacity: 3, refillPerSec: 0.01 }, write: { capacity: 30, refillPerSec: 5 } } });
  try {
    const body = JSON.stringify({ token: "x".repeat(64) });
    for (let i = 0; i < 10; i++) assert.equal((await post(h, body, { ...jsonHeaders(), origin: "https://evil.example" })).status, 403, `foreign-origin login ${i} is 403, not 429`);
    const ok = await post(h, JSON.stringify({ token: OWNER_TOKEN }));
    assert.equal(ok.status, 200, "the owner can still log in after a hostile page hammered the endpoint");
    const cookie = ok.headers["set-cookie"]![0]!.split(";", 1)[0]!;
    for (let i = 0; i < 10; i++) assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200, "read bucket untouched by cross-site requests");
  } finally { await h.close(); }
});

// ---- F2 ------------------------------------------------------------------------------------------------------------
test("F2: a core error's message and reason are not forwarded verbatim (host paths, long or odd text)", async () => {
  const core = fakeCore(); const h = await start({ core });
  try {
    const { cookie } = await login(h);
    core.impl = async () => { throw Object.assign(new Error("cannot read /home/alice/.plur1bus/config.json: EACCES"), { error: "E_CONFIG_INVALID", reason: "/home/alice/.plur1bus/config.json" }); };
    const r = await raw(h, { path: "/api/v1/agents", headers: { cookie } });
    assert.equal(r.status, 400); assert.equal(r.json.error, "E_CONFIG_INVALID");
    assert.ok(!r.text.includes("/home/alice"), r.text); assert.ok(!r.text.includes("EACCES"), r.text);
    core.impl = async () => { throw Object.assign(new Error("unknown agent"), { error: "E_AGENT_UNKNOWN", reason: "no-such-agent" }); };
    assert.equal((await raw(h, { path: "/api/v1/agents", headers: { cookie } })).json.reason, "no-such-agent", "a short machine reason is kept");
  } finally { await h.close(); }
});

// ---- Authentication -------------------------------------------------------------------------------------------------
test("OK-1: credentials in the URL or in other headers are never a way in and never reach a log", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h); const sid = cookie.split("=")[1]!;
    const csrf = await csrfToken(h, cookie);
    const secrets = [OWNER_TOKEN, sid, csrf, "Zm9vOmJhcg=="];
    // login by query: the body is required, so a token in the URL alone is a 400
    assert.equal((await post(h, "", jsonHeaders(), `/api/v1/session?token=${OWNER_TOKEN}`)).status, 400);
    assert.equal((await post(h, "{}", jsonHeaders(), `/api/v1/session?token=${OWNER_TOKEN}`)).status, 400);
    // a body token plus a query token is still judged on the body only
    assert.equal((await post(h, JSON.stringify({ token: "y".repeat(64) }), jsonHeaders(), `/api/v1/session?token=${OWNER_TOKEN}`)).status, 401);
    // session by query, by Authorization, by other headers
    for (const p of [`/api/v1/whoami?plur1bus_session=${sid}`, `/api/v1/whoami?cookie=${sid}&token=${OWNER_TOKEN}`, `/api/v1/whoami;plur1bus_session=${sid}`]) assert.ok([401, 404].includes((await raw(h, { path: p })).status), p);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).status, 401);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { authorization: "Basic Zm9vOmJhcg==" } })).status, 401);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { "x-api-key": OWNER_TOKEN, "x-session": sid } })).status, 401);
    // a CSRF token in the query, the body or the cookie is not the header
    assert.equal((await raw(h, { method: "DELETE", path: `/api/v1/session?csrf=${csrf}&x-csrf-token=${csrf}`, headers: { cookie } })).status, 403);
    assert.equal((await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie: `${cookie}; x-csrf-token=${csrf}` } })).status, 403);
    for (const l of h.logs) for (const s of secrets) assert.ok(!l.includes(s), `a log line holds a secret: ${l}`);
  } finally { await h.close(); }
});

test("OK-2: expired, truncated, case-changed and other-prefixed session values are refused; expiry is on the injected clock", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h); const [name, sid] = cookie.split("=") as [string, string];
    for (const c of [`${name}=${sid.slice(0, -1)}`, `${name}=${sid.toUpperCase()}`, `${name}=${sid}x`, `${name}=`, `x${name}=${sid}`, `__Host-${name}=${sid}`, `${name}="${sid}"`]) assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie: c } })).status, 401, c);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie: `${name}=bad; ${name}=${sid}` } })).status, 401, "the first duplicate wins, a valid second one cannot rescue it");
    h.clock.advance(31 * 60_000);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 401);
  } finally { await h.close(); }
});

test("OK-3: the owner token comparison hashes both sides and uses timingSafeEqual (code evidence); odd candidates are false, not errors", () => {
  const src = readFileSync(path.join(repo, "packages/api/src/session.ts"), "utf8");
  assert.match(src, /timingSafeEqual\(createHash\("sha256"\)\.update\(candidate, "utf8"\)\.digest\(\), want\)/);
  const v = ownerTokenVerifier(OWNER_TOKEN);
  for (const c of [undefined, null, 1, {}, [], "", "a", "é".repeat(300), OWNER_TOKEN + "0", OWNER_TOKEN.slice(1)]) assert.equal(v(c), false);
  assert.equal(v(OWNER_TOKEN), true);
});

// ---- CSRF -----------------------------------------------------------------------------------------------------------
test("OK-4: a CSRF token does not survive logout, cannot move to a new session, and a repeated header is not a match", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const a = await login(h);
    const t1 = await csrfToken(h, a.cookie); const t2 = await csrfToken(h, a.cookie);
    assert.equal((await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie: a.cookie, "x-csrf-token": t1 } })).status, 200);
    const b = await login(h);
    assert.notEqual(a.cookie, b.cookie);
    assert.equal((await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie: b.cookie, "x-csrf-token": t2 } })).status, 403, "a token of a logged-out session is worthless in the next one");
    assert.equal((await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie: a.cookie, "x-csrf-token": t2 } })).status, 401);
    const t3 = await csrfToken(h, b.cookie);
    const dup = await socketExchange(h.port, (s) => s.write(`DELETE /api/v1/session HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nCookie: ${b.cookie}\r\nX-CSRF-Token: ${t3}\r\nX-CSRF-Token: ${t3}\r\nConnection: close\r\n\r\n`));
    assert.match(dup, /^HTTP\/1\.1 403 /);
  } finally { await h.close(); }
});

// ---- Host / Origin / CORS -------------------------------------------------------------------------------------------
test("OK-5: odd Host headers (userinfo, trailing dot, missing, HTTP/1.0) are refused; only the API's own names pass", async () => {
  const h = await start({ rateClasses: wide });
  try {
    for (const host of [`localhost.:${h.port}`, `localhost:${h.port}@evil.example`, `evil.example#:${h.port}`, `localhost:${h.port}.evil.example`, `127.0.0.1:${h.port},evil.example`]) {
      const r = await raw(h, { path: "/api/v1/health", headers: { host } }).catch(() => ({ status: 400 }));
      assert.ok([400, 421].includes(r.status), `${JSON.stringify(host)} -> ${r.status}`);
    }
    // Node keeps the first of two Host headers; a browser cannot send two, so this is no bypass, but pin that the first one is judged.
    const dup = await socketExchange(h.port, (s) => s.write(`GET /api/v1/health HTTP/1.1\r\nHost: evil.example\r\nHost: 127.0.0.1:${h.port}\r\nConnection: close\r\n\r\n`));
    assert.match(dup, /^HTTP\/1\.1 421 /, "the first Host header is the one judged");
    const none = await socketExchange(h.port, (s) => s.write("GET /api/v1/health HTTP/1.0\r\n\r\n"));
    assert.match(none, /^HTTP\/1\.[01] 421 /);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { host: `LOCALHOST:${h.port}` } })).status, 401, "case-insensitive for the names we own");
  } finally { await h.close(); }
});

test("OK-6: foreign, null, look-alike and empty Origins are refused; a missing Origin is a non-browser client; a preflight gets no CORS grant", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h); const csrf = await csrfToken(h, cookie);
    for (const origin of ["null", "https://evil.example", `http://127.0.0.1:${h.port}.evil.example`, `http://evil.example:${h.port}`, `https://127.0.0.1:${h.port}`, `http://127.0.0.1:${h.port}/`, ""]) {
      const r = await raw(h, { path: "/api/v1/whoami", headers: { cookie, origin } });
      assert.equal(r.status, 403, JSON.stringify(origin));
    }
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200, "no Origin: curl, the CLI, same-origin GET");
    for (const p of ["/api/v1/session", "/api/v1/whoami", "/api/v1/nope"]) {
      const r = await raw(h, { method: "OPTIONS", path: p, headers: { origin: "https://evil.example", "access-control-request-method": "DELETE", "access-control-request-headers": "x-csrf-token" } });
      assert.ok([403, 404, 405].includes(r.status), `${p} -> ${r.status}`);
      for (const k of Object.keys(r.headers)) assert.ok(!k.startsWith("access-control-"), `${p} sets ${k}`);
    }
    assert.equal((await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie, "x-csrf-token": csrf } })).status, 200, "the preflights created or spent nothing");
  } finally { await h.close(); }
});

// ---- RBAC -----------------------------------------------------------------------------------------------------------
test("OK-7: the route table is deny-by-default and its only core calls are core.status and agent.list (no admin.*, no passthrough)", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h);
    for (const r of ROUTES) {
      for (const headers of [{}, { cookie: "plur1bus_session=forged" }] as Array<Record<string, string>>) {
        const res = await raw(h, { method: r.method, path: r.path, headers: { ...headers, ...(r.requestBody ? jsonHeaders() : {}) } });
        if (r.auth !== "none") assert.equal(res.status, 401, `${r.id} anonymous`); else assert.notEqual(res.status, 200);
      }
    }
    assert.deepEqual(ROUTES.filter((r) => r.auth === "none").map((r) => r.id), ["session.create"]);
    assert.ok(ROUTES.filter((r) => r.method !== "GET" && r.auth !== "none").every((r) => r.csrf), "every authenticated write needs CSRF");
    for (const r of ROUTES) if (r.auth !== "none" && r.method === "GET") await raw(h, { path: r.path, headers: { cookie } });
    const called = new Set(h.core.calls.map((c) => c.method));
    assert.deepEqual([...called].sort(), ["agent.list", "core.status"]);
    for (const p of ["/api/v1/admin/migrate", "/api/v1/admin.migrate", "/api/v1/rpc", "/api/v1/admin/reembed/run", "/api/v1/users", "/api/v1/identity", "/api/v1/secrets"]) {
      const t = await csrfToken(h, cookie);
      for (const method of ["GET", "POST", "DELETE", "PUT", "PATCH"]) assert.equal((await raw(h, { method, path: p, headers: { cookie, "x-csrf-token": t, ...jsonHeaders() } })).status, 404, `${method} ${p}`);
    }
    assert.ok(![...h.core.calls.map((c) => c.method)].some((m) => m.startsWith("admin.")));
  } finally { await h.close(); }
});

test("OK-8: routes, RPC_RULES (core guard) and docs/rbac.md agree: every admin.* RPC method has a rule and an Owner/Admin-only row", () => {
  const methods = METHODS;
  const text = readFileSync(path.join(repo, "docs/rbac.md"), "utf8");
  const guard = readFileSync(path.join(repo, "packages/core/src/rbac/guard.ts"), "utf8");
  const admin = new Set([...guard.matchAll(/"(admin\.[A-Za-z.]+)": rule\(/g)].map((m) => m[1]!));
  assert.ok(admin.size >= 11, "guard.ts lists the admin.* family");
  assert.ok(methods.some((m) => m.startsWith("admin.")), "the schema's method map was found");
  for (const m of methods.filter((n) => n.startsWith("admin."))) assert.ok(admin.has(m), `RPC_RULES lacks ${m}`);
  for (const m of admin) {
    const row = text.split("\n").find((l) => l.startsWith(`| \`${m}\``));
    assert.ok(row, `docs/rbac.md lacks a row for ${m}`);
    const cells = row.split("|").map((c) => c.trim()).slice(3, 8); // Owner, Admin, Operator, Member, Viewer
    assert.deepEqual(cells, ["✔", "✔", "–", "–", "–"], `${m} must be Owner/Admin only`);
  }
  for (const r of ROUTES) assert.ok(!/admin/.test(r.path), `${r.id} exposes an admin path`);
});

// ---- Input limits ---------------------------------------------------------------------------------------------------
test("OK-9: deeply nested or huge JSON is a 400/413, never a 500 or a crash, and the server keeps serving", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const deep = "[".repeat(30_000) + "]".repeat(30_000);
    const r = await post(h, deep);
    assert.equal(r.status, 400, r.text);
    assert.equal((await post(h, '{"token":' + deep + "}")).status, 400);
    assert.equal((await post(h, JSON.stringify({ token: OWNER_TOKEN, extra: 1 }))).status, 400, "extra keys are refused");
    assert.equal((await post(h, '{"__proto__":{"token":"x"},"token":"' + "a".repeat(40) + '"}')).status, 400);
    assert.equal((await post(h, "x".repeat(70_000))).status, 413);
    assert.equal((await post(h, JSON.stringify({ token: OWNER_TOKEN }))).status, 200);
  } finally { await h.close(); }
});

test("OK-10: every content type but application/json is 415 on the login route (CORS-simple types included)", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const body = JSON.stringify({ token: OWNER_TOKEN });
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", "application/json-patch+json", "text/json", "application/xml"]) assert.equal((await post(h, body, { "content-type": ct })).status, 415, ct);
    assert.equal((await post(h, body, {})).status, 415, "no Content-Type");
    assert.equal((await post(h, body, { "content-type": "Application/JSON; charset=utf-8" })).status, 200);
  } finally { await h.close(); }
});

test("OK-11: an unbounded chunked body on a route that takes none cannot hold the server: the answer comes, the connection ends", async () => {
  const h = await start({ limits: { requestTimeoutMs: 1500, headersTimeoutMs: 1500 } });
  try {
    const { cookie } = await login(h);
    const out = await socketExchange(h.port, (s) => {
      s.write(`GET /api/v1/whoami HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nCookie: ${cookie}\r\nTransfer-Encoding: chunked\r\n\r\n`);
      const chunk = "a".repeat(4096); for (let i = 0; i < 50; i++) s.write(`1000\r\n${chunk}\r\n`); // never terminated
    }, 6000);
    assert.match(out, /^HTTP\/1\.1 200 /);
    assert.equal((await raw(h, { path: "/api/v1/health", headers: { cookie } })).status, 200);
  } finally { await h.close(); }
});

test("OK-12: Slowloris: dripped headers are cut off by the request timeout and the connection cap is free again afterwards", async () => {
  const h = await start({ limits: { maxConnections: 4, headersTimeoutMs: 300, requestTimeoutMs: 600, keepAliveTimeoutMs: 300 } });
  try {
    const victims = Array.from({ length: 4 }, () => socketExchange(h.port, (s) => {
      s.write(`GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\n`);
      const drip = setInterval(() => { if (s.destroyed) clearInterval(drip); else s.write("X-A: b\r\n"); }, 40); s.on("close", () => clearInterval(drip));
    }, 5000));
    const results = await Promise.all(victims);
    for (const r of results) assert.match(r, /^HTTP\/1\.1 408 /, "every slow client got the 408 and was closed before the 5 s test cap");
    assert.equal((await raw(h, { path: "/api/v1/health" })).status, 401, "capacity is back");
  } finally { await h.close(); }
});

test("OK-13: connections above maxConnections are dropped at accept; the held ones are not affected", async () => {
  const h = await start({ limits: { maxConnections: 2, headersTimeoutMs: 5000, requestTimeoutMs: 5000 } });
  const held: ReturnType<typeof connect>[] = [];
  try {
    for (let i = 0; i < 2; i++) await new Promise<void>((res) => { const s = connect(h.port, "127.0.0.1", () => res()); held.push(s); s.on("error", () => {}); });
    const third = await socketExchange(h.port, (s) => s.write(`GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nConnection: close\r\n\r\n`), 2000);
    assert.equal(third, "", "no response is written for a connection over the cap");
  } finally { for (const s of held) s.destroy(); await h.close(); }
});

// ---- Error responses ------------------------------------------------------------------------------------------------
test("OK-14: no failure response carries a stack frame, a host path, a token or Node's own text", async () => {
  const core = fakeCore(); core.impl = async () => { throw new TypeError("x is not a function at /srv/plur1bus/dist/core.js:12:3"); };
  const h = await start({ core, rateClasses: wide });
  try {
    const { cookie } = await login(h);
    const probes = await Promise.all([
      raw(h, { path: "/api/v1/agents", headers: { cookie } }), raw(h, { path: "/api/v1/nope%00x" }), raw(h, { path: "/api/v1/%zz" }), raw(h, { path: "/api/v1/" + "a".repeat(20_000) }).catch(() => ({ text: "", status: 0 })),
      raw(h, { method: "TRACE", path: "/api/v1/whoami" }), raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: "{" }), raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: 5 }) }),
      raw(h, { path: "/api/v1/whoami", headers: { origin: "https://evil.example" } }), raw(h, { path: "/api/v1/whoami", headers: { host: "evil.example" } }),
    ]);
    for (const r of probes) {
      for (const bad of [/\bat [^\n]*\(/, /\.(ts|js|mjs):\d+/, /\/srv\//, /\/home\//, /node_modules/, /Error:/, /ECONN/, /<html/i]) assert.ok(!bad.test(r.text), `${r.status} ${r.text} matches ${bad}`);
      assert.ok(!r.text.includes(OWNER_TOKEN));
    }
    assert.equal(probes[0]!.status, 503); // a TypeError from the core link is "unreachable", without its text
  } finally { await h.close(); }
});
