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
const wide = { auth: { capacity: 1000, refillPerSec: 100 }, read: { capacity: 1000, refillPerSec: 100 }, write: { capacity: 1000, refillPerSec: 100 }, totp: { capacity: 1000, refillPerSec: 100 }, stream: { capacity: 1000, refillPerSec: 100 } };

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
    assert.deepEqual(ROUTES.filter((r) => r.auth === "none").map((r) => r.id), ["session.create", "session.totp"]);
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

// ---- Q12: authN and hardening (api-authn-hardening) -----------------------------------------------------------------
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { addUser, FIXTURE_PASSWORD, loginAs, write } from "./helpers.ts";

const loginBody = (username: string, password: string) => JSON.stringify({ username, password });

test("Q12-1: session ids are 256-bit random and unique, never in a body or a URL, and the cookie has no Domain", async () => {
  const h = await start({ rateClasses: wide });
  try {
    await addUser(h, { id: "u-mia", username: "mia", role: "member" });
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r = await post(h, loginBody("mia", FIXTURE_PASSWORD));
      const set = r.headers["set-cookie"]![0]!; const id = /^plur1bus_session=([A-Za-z0-9_-]+);/.exec(set)![1]!;
      assert.equal(id.length, 43); assert.ok(!/;\s*Domain=/i.test(set)); assert.ok(!r.text.includes(id)); seen.add(id);
    }
    assert.equal(seen.size, 40);
  } finally { await h.close(); }
});

test("Q12-2: every authenticated write on the route table needs the one-time CSRF token and refuses a foreign Origin or Referer even with one", async () => {
  const h = await start({ rateClasses: wide });
  try {
    await addUser(h, { id: "u-adam", username: "adam", role: "admin" });
    const { cookie } = await loginAs(h, "adam");
    for (const r of ROUTES.filter((x) => x.auth !== "none" && x.method !== "GET")) {
      assert.equal(r.csrf, true, r.id);
      const bare = await raw(h, { method: r.method, path: r.path, headers: { cookie, ...jsonHeaders() }, body: r.requestBody ? "{}" : undefined as never });
      assert.deepEqual([bare.status, bare.json.reason], [403, "csrf"], `${r.id} without a token`);
      for (const extra of [{ origin: "https://evil.example" }, { referer: "https://evil.example/x" }, { "sec-fetch-site": "cross-site" }]) {
        const t = await csrfToken(h, cookie);
        const x = await raw(h, { method: r.method, path: r.path, headers: { cookie, "x-csrf-token": t, ...jsonHeaders(), ...extra }, body: r.requestBody ? "{}" : undefined as never });
        assert.equal(x.status, 403, `${r.id} ${Object.keys(extra)[0]}`); assert.notEqual(x.json.reason, undefined);
      }
    }
  } finally { await h.close(); }
});

test("Q12-3: identity and role come from the server, never from a header or a body field: spoofed identity headers change nothing, extra body fields are refused", async () => {
  const h = await start({ rateClasses: wide });
  try {
    await addUser(h, { id: "u-mia", username: "mia", role: "member" });
    const { cookie } = await loginAs(h, "mia");
    const spoof = { "x-user-id": "owner", "x-role": "owner", "x-forwarded-user": "owner", "remote-user": "owner", "x-auth-user": "owner", "x-original-user": "owner" };
    const who = await raw(h, { path: "/api/v1/whoami", headers: { cookie, ...spoof } });
    assert.deepEqual(who.json.principal, { kind: "user", id: "u-mia", role: "member" });
    assert.equal((await raw(h, { path: "/api/v1/health", headers: { cookie, ...spoof } })).status, 403);
    for (const body of [{ username: "mia", password: FIXTURE_PASSWORD, role: "owner" }, { username: "mia", password: FIXTURE_PASSWORD, userId: "owner" }, { token: OWNER_TOKEN, role: "x" }]) assert.equal((await post(h, JSON.stringify(body))).status, 400, JSON.stringify(Object.keys(body)));
    for (const extra of [{ role: "owner" }, { userId: "owner" }, { admin: true }]) assert.equal((await write(h, cookie, { path: "/api/v1/tokens", body: { name: "x", scopes: ["agent.read"], ...extra } })).json.reason, "body");
    assert.equal((await write(h, cookie, { path: "/api/v1/tokens", body: { name: "x", scopes: ["*"] } })).json.reason, "scope", "a wildcard over everything is not a scope");
  } finally { await h.close(); }
});

test("Q12-4: password spraying from one address is stopped by the login bucket whatever the names (a right password is refused too until it refills)", async () => {
  const h = await start({ rateClasses: { ...wide, auth: { capacity: 5, refillPerSec: 0.001 } } });
  try {
    await addUser(h, { id: "u-mia", username: "mia", role: "member" });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post(h, loginBody(`user${i}`, "guess"))).status);
    assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]); assert.ok(codes.slice(5).every((c) => c === 429), JSON.stringify(codes));
    const r = await post(h, loginBody("mia", FIXTURE_PASSWORD));
    assert.equal(r.status, 429, "the right password from the sprayed address is refused too until the bucket refills"); assert.ok(r.headers["retry-after"]);
  } finally { await h.close(); }
});

test("Q12-5: nothing the client sends is reflected into a response header or body: CR/LF, Set-Cookie look-alikes in path, query, cookie, Authorization, CSRF, Referer and login fields", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const marker = "INJECTED-MARKER";
    const evil = `x%0d%0aSet-Cookie:%20${marker}=1%0d%0aX-Injected:%20${marker}`;
    const probes: Array<Promise<Awaited<ReturnType<typeof raw>>>> = [
      raw(h, { path: `/api/v1/${evil}` }), raw(h, { path: `/api/v1/whoami?next=${evil}` }),
      raw(h, { path: "/api/v1/whoami", headers: { cookie: `plur1bus_session=${marker}` } }),
      raw(h, { path: "/api/v1/whoami", headers: { authorization: `Bearer plb_${marker}` } }),
      raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie: `plur1bus_session=${marker}`, "x-csrf-token": marker } }),
      raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), referer: `https://x/${marker}` }, body: "{}" }),
      post(h, JSON.stringify({ username: `${marker}\r\nSet-Cookie: ${marker}=1`, password: marker })), post(h, JSON.stringify({ token: marker.repeat(5) })),
      raw(h, { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: JSON.stringify({ challenge: marker, code: marker }) }),
    ];
    for (const p of probes) {
      const r = await p;
      assert.equal(r.headers["x-injected"], undefined); assert.ok(!JSON.stringify(r.headers).includes(marker), JSON.stringify(r.headers)); assert.ok(!r.text.includes(marker), r.text.slice(0, 120));
      assert.equal(r.headers["set-cookie"], undefined);
    }
    assert.ok(!h.logs.join("\n").includes(marker), "nor into the log");
    assert.ok(!JSON.stringify(h.audit.events).includes(marker), "nor into the audit");
    const lit = await socketExchange(h.port, (s) => s.write(`GET /api/v1/whoami HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nCookie: a=b\r\nX-Smuggle: 1\rInjected: ${marker}\r\n\r\n`));
    assert.ok(!lit.includes(`Injected: ${marker}`) && !lit.includes("Set-Cookie: INJECTED"), "a bare CR is not turned into a header");
  } finally { await h.close(); }
});

test("Q12-6: no open redirect: crafted paths never answer 3xx or a Location header, with the web app served or not", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "plur1bus-redir-")); const root = path.join(base, "dist"); mkdirSync(root);
  writeFileSync(path.join(root, "index.html"), "<!doctype html><script src=./m.js></script>");
  const paths = ["//evil.example", "//evil.example/x", "/\\evil.example", "/%2f%2fevil.example", "/%5cevil.example", "/https://evil.example", "/..//evil.example", "/api/v1/session?next=//evil.example", "/api/v1/whoami?redirect=https://evil.example", "/api/v1//whoami", "/api/v1/whoami/", "/api/v1/session/", "/index.html/", "/./", "/%2e/"];
  for (const webRoot of [undefined, root]) {
    const h = await start({ rateClasses: wide, ...(webRoot ? { webRoot } : {}) });
    try {
      for (const p of paths) for (const method of ["GET", "POST", "HEAD"]) {
        const r = await raw(h, { method, path: p, headers: method === "POST" ? jsonHeaders() : {}, body: method === "POST" ? "{}" : undefined as never });
        assert.ok(r.status < 300 || r.status >= 400, `${method} ${p} -> ${r.status}`); assert.equal(r.headers.location, undefined, `${method} ${p}`);
      }
    } finally { await h.close(); }
  }
  rmSync(base, { recursive: true, force: true });
});

test("Q12-7: forwarding and override headers are not trusted: a fresh X-Forwarded-For per request gives no fresh rate bucket, method override and proto/host hints are ignored", async () => {
  const h = await start({ rateClasses: { ...wide, auth: { capacity: 2, refillPerSec: 0.001 } } });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), "x-forwarded-for": `10.0.0.${i}`, "x-real-ip": `10.1.0.${i}`, forwarded: `for=10.2.0.${i}` }, body: JSON.stringify({ token: "b".repeat(64) }) })).status);
    assert.deepEqual(codes, [401, 401, 429, 429, 429]);
  } finally { await h.close(); }
  const h2 = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h2);
    const t = await csrfToken(h2, cookie);
    const r = await raw(h2, { method: "POST", path: "/api/v1/session", headers: { cookie, "x-csrf-token": t, "x-http-method-override": "DELETE", "x-method-override": "DELETE", ...jsonHeaders() }, body: JSON.stringify({ token: OWNER_TOKEN }) });
    assert.equal(r.json.schema, "session.create/1", "POST stays POST");
    const l = await raw(h2, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), "x-forwarded-proto": "https", "x-forwarded-host": "evil.example" }, body: JSON.stringify({ token: OWNER_TOKEN }) });
    assert.equal(l.status, 200); assert.doesNotMatch(l.headers["set-cookie"]![0]!, /Secure|__Host-/, "plain HTTP stays plain whatever a proxy header claims");
  } finally { await h2.close(); }
});

test("Q12-8: prototype pollution and odd JSON on the new routes: __proto__/constructor keys are refused, nothing leaks into Object.prototype, oversized bodies are 413", async () => {
  const h = await start({ rateClasses: wide });
  try {
    await addUser(h, { id: "u-mia", username: "mia", role: "member" });
    const { cookie } = await loginAs(h, "mia");
    for (const raw1 of ['{"__proto__":{"role":"owner"},"username":"mia","password":"x"}', '{"constructor":{"prototype":{"admin":true}},"token":"x"}', '{"username":"mia","password":"x","__proto__":1}']) assert.equal((await post(h, raw1)).status, 400, raw1.slice(0, 30));
    const t = await write(h, cookie, { path: "/api/v1/tokens", body: JSON.parse('{"name":"x","scopes":["agent.read"],"__proto__":{"role":"owner"}}') });
    assert.deepEqual([t.status, t.json.reason], [400, "body"], "an own __proto__ key in a token request is an extra field, refused");
    assert.equal(({} as Record<string, unknown>).role, undefined); assert.equal(({} as Record<string, unknown>).admin, undefined);
    const big = JSON.stringify({ name: "x", scopes: ["agent.read"], pad: "a".repeat(70_000) });
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/tokens", headers: { cookie, "x-csrf-token": await csrfToken(h, cookie), ...jsonHeaders() }, body: big })).status, 413);
    for (const body of ["[]", "null", '"str"', "5", "true"]) assert.equal((await post(h, body)).status, 400, body);
    assert.equal((await post(h, JSON.stringify({ username: ["mia"], password: "x" }))).status, 400);
  } finally { await h.close(); }
});

test("Q12-9: no route, new or old, grants CORS: a cross-origin preflight or request is refused with no access-control header, static files included", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "plur1bus-cors-")); const root = path.join(base, "dist"); mkdirSync(root); writeFileSync(path.join(root, "index.html"), "<html></html>");
  const h = await start({ rateClasses: wide, webRoot: root });
  try {
    for (const r of [...ROUTES, { method: "GET", path: "/" }, { method: "GET", path: "/main.js" }]) {
      for (const method of ["OPTIONS", r.method]) {
        const res = await raw(h, { method, path: r.path, headers: { origin: "https://evil.example", "access-control-request-method": r.method, "access-control-request-headers": "x-csrf-token" } });
        assert.equal(res.status, 403, `${method} ${r.path}`);
        for (const k of Object.keys(res.headers)) assert.ok(!k.startsWith("access-control-"), `${r.path}: ${k}`);
      }
    }
  } finally { await h.close(); rmSync(base, { recursive: true, force: true }); }
});

test("Q12-10: a login that sends its headers and then dribbles or stalls on the body is cut off by the request timeout; the server keeps serving", async () => {
  const h = await start({ rateClasses: wide, limits: { requestTimeoutMs: 400, headersTimeoutMs: 300 } });
  try {
    const out = await socketExchange(h.port, (s) => { s.write(`POST /api/v1/session HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"user`); }, 4000);
    assert.ok(!out.includes(" 200 ") && !out.includes("Set-Cookie"), out.slice(0, 200)); assert.ok(out === "" || /HTTP\/1\.1 (408|400|413)/.test(out), out.slice(0, 120));
    assert.equal((await raw(h, { path: "/api/v1/health" })).status, 401, "still serving");
  } finally { await h.close(); }
});
