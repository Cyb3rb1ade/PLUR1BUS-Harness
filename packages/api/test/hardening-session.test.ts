// Step 1 of the server hardening sweep: sessions, cookies and the security headers on every route.
// Already pinned elsewhere (not repeated here): fixation at password login (accounts.test.ts) and at the second step
// (totp-api.test.ts), server-side logout (auth.test.ts), idle and absolute expiry (session.test.ts, auth.test.ts),
// the Secure/__Host- cookie over TLS (headers.test.ts), truncated or case-changed values (redteam.test.ts OK-2).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CSP, htmlCsp, securityHeaders } from "../src/headers.ts";
import { ROUTES } from "../src/routes.ts";
import { addUser, csrfToken, FIXTURE_PASSWORD, jsonHeaders, login, loginAs, OWNER_TOKEN, raw, start, type Harness, type Res } from "./helpers.ts";

const wide = { auth: { capacity: 100_000, refillPerSec: 10_000 }, read: { capacity: 100_000, refillPerSec: 10_000 }, write: { capacity: 100_000, refillPerSec: 10_000 }, totp: { capacity: 100_000, refillPerSec: 10_000 }, stream: { capacity: 100_000, refillPerSec: 10_000 } };
const whoami = (h: Harness, cookie: string) => raw(h, { path: "/api/v1/whoami", headers: { cookie } });

/** The first line of an HTTP/1.1 answer and its headers, from a request written byte for byte (the Node client refuses
 *  to send most of what these tests send). */
function exchange(port: number, request: string | Buffer, ms = 4000): Promise<{ status: number; head: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1"); const chunks: Buffer[] = [];
    const t = setTimeout(() => { s.destroy(); reject(new Error("exchange timed out")); }, ms);
    s.on("data", (c) => chunks.push(c)); s.on("error", () => {});
    s.on("close", () => { clearTimeout(t); const text = Buffer.concat(chunks).toString("latin1"); resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0), head: text.split("\r\n\r\n", 1)[0] ?? "" }); });
    s.on("connect", () => s.write(request));
  });
}
const rawCookieRequest = (port: number, cookie: string | Buffer): Buffer => Buffer.concat([Buffer.from(`GET /api/v1/whoami HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nCookie: `, "latin1"), Buffer.isBuffer(cookie) ? cookie : Buffer.from(cookie, "latin1"), Buffer.from("\r\n\r\n", "latin1")]);

// ---- security headers on every route -------------------------------------------------------------------------------

function assertSecurityHeaders(h: Record<string, string | string[] | undefined>, label: string, html = false): void {
  for (const [k, v] of Object.entries(securityHeaders(false))) {
    if (html && k === "Content-Security-Policy") continue;
    assert.equal(h[k.toLowerCase()], v, `${label}: ${k}`);
  }
  const csp = String(h["content-security-policy"]);
  if (!html) assert.equal(csp, CSP, label);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), `${label}: the CSP allows inline or eval`);
  assert.match(csp, /frame-ancestors 'none'/, label); assert.equal(h["x-frame-options"], "DENY", label);
  assert.equal(h["x-content-type-options"], "nosniff", label); assert.equal(h["referrer-policy"], "no-referrer", label);
  assert.equal(h["strict-transport-security"], undefined, `${label}: no HSTS over plain HTTP`);
}

test("every route of the table carries the security headers: anonymous, signed in, and with a method the route does not have", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h);
    for (const spec of ROUTES) {
      const other = spec.method === "GET" ? "PUT" : "GET"; // a verb the table lacks on every path
      const ends = spec.id === "session.delete" || spec.id === "sessions.revoke-all"; // covered with a fresh login each, next test
      const cases: Array<[string, Res]> = [
        [`${spec.id} anonymous`, await raw(h, { method: spec.method, path: spec.path })],
        ...(spec.requestBody ? [[`${spec.id} anonymous with a body`, await raw(h, { method: spec.method, path: spec.path, headers: jsonHeaders(), body: "{}" })] as [string, Res]] : []),
        [`${spec.id} signed in`, await raw(h, { method: spec.method, path: spec.path, headers: { cookie, ...(spec.requestBody ? jsonHeaders() : {}) }, ...(spec.requestBody ? { body: "{}" } : {}) })],
        ...(ends ? [] : [[`${spec.id} signed in with CSRF`, await raw(h, { method: spec.method, path: spec.path, headers: { cookie, "x-csrf-token": await csrfToken(h, cookie), ...(spec.requestBody ? jsonHeaders() : {}) }, ...(spec.requestBody ? { body: "{}" } : {}) })] as [string, Res]]),
        [`${spec.id} wrong method`, await raw(h, { method: other === "GET" && ROUTES.some((r) => r.path === spec.path && r.method === "GET") ? "PATCH" : other, path: spec.path, headers: { cookie } })],
        [`${spec.id} foreign Origin`, await raw(h, { method: spec.method, path: spec.path, headers: { cookie, origin: "https://evil.example" } })],
        [`${spec.id} query string`, await raw(h, { method: spec.method, path: `${spec.path}?x=1&token=redact-probe-alpha`, headers: { cookie } })],
      ];
      for (const [label, r] of cases) { assertSecurityHeaders(r.headers, label); assert.ok(r.status >= 200 && r.status < 600, label); }
    }
  } finally { await h.close(); }
});

test("headers on every route, continued: routes that end the session come last, with a fresh login each", async () => {
  for (const id of ["session.delete", "sessions.revoke-all"]) {
    const h = await start({ rateClasses: wide });
    try {
      const { cookie } = await login(h); const spec = ROUTES.find((r) => r.id === id)!;
      const r = await raw(h, { method: spec.method, path: spec.path, headers: { cookie, "x-csrf-token": await csrfToken(h, cookie) } });
      assert.equal(r.status, 200, id); assertSecurityHeaders(r.headers, id);
    } finally { await h.close(); }
  }
});

test("every route of the table is declared once, and the table is the only source the header sweep iterates", () => {
  const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length, "a duplicate route would hide one from the sweep");
  assert.ok(ROUTES.length >= 18, "the table did not shrink silently");
});

test("an unknown path, a deep path and a dot-segment path carry the headers too, as do HEAD, OPTIONS and TRACE; CONNECT opens no tunnel", async () => {
  const h = await start({ rateClasses: wide });
  try {
    for (const [method, p] of [["GET", "/nope"], ["GET", "/api"], ["GET", "/api/"], ["GET", "/api/v1"], ["GET", `/api/v1/${"a/".repeat(200)}`], ["GET", "/api/v1/../v1/whoami"], ["HEAD", "/api/v1/whoami"], ["OPTIONS", "/api/v1/whoami"], ["TRACE", "/api/v1/whoami"]] as const) {
      const r = await raw(h, { method, path: p }); assertSecurityHeaders(r.headers, `${method} ${p.slice(0, 30)}`);
    }
    // Node closes a CONNECT socket itself when no listener exists: nothing is answered, which is the safe outcome (no tunnel).
    const tunnel = await exchange(h.port, `CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n`);
    assert.ok(tunnel.status === 0 || tunnel.status >= 400, `CONNECT is never a 2xx: ${tunnel.status}`);
  } finally { await h.close(); }
});

test("the app shell (webRoot) keeps nosniff, X-Frame-Options and frame-ancestors; its CSP has a per-response nonce and no unsafe-inline", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "plur1bus-hardening-")); const root = path.join(base, "dist"); mkdirSync(path.join(root, "assets"), { recursive: true });
  writeFileSync(path.join(root, "index.html"), `<!doctype html><html><head><script type="module" src="./main.js"></script><style>b{}</style></head><body></body></html>`);
  writeFileSync(path.join(root, "main.js"), "1"); writeFileSync(path.join(root, "assets", "a.css"), "a{}");
  const h = await start({ webRoot: root, rateClasses: wide });
  try {
    const nonces = new Set<string>();
    for (const p of ["/", "/index.html", "/some/client/route", "/main.js", "/assets/a.css", "/missing.js"]) {
      const r = await raw(h, { path: p }); const html = /text\/html/.test(String(r.headers["content-type"]));
      assertSecurityHeaders(r.headers, `static ${p}`, html);
      if (html) {
        const m = /script-src 'nonce-([^']+)' 'strict-dynamic'/.exec(String(r.headers["content-security-policy"])); assert.ok(m, `static ${p}: nonce in the CSP`);
        nonces.add(m![1]!); assert.equal(r.headers["content-security-policy"], htmlCsp(m![1]!)); assert.ok(r.text.includes(`nonce="${m![1]}"`), "the nonce reaches the tags");
      }
    }
    assert.ok(nonces.size >= 3, "one fresh nonce per HTML response");
  } finally { await h.close(); rmSync(base, { recursive: true, force: true }); }
});

// ---- sessions ------------------------------------------------------------------------------------------------------

test("owner-token login ends a cookie the request carried and issues a new one (fixation, owner path)", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const first = await login(h);
    const second = await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), cookie: first.cookie }, body: JSON.stringify({ token: OWNER_TOKEN }) });
    const next = second.headers["set-cookie"]![0]!.split(";", 1)[0]!;
    assert.notEqual(next, first.cookie); assert.equal((await whoami(h, first.cookie)).status, 401); assert.equal((await whoami(h, next)).status, 200);
    // A refused login must not end the presented session: only a successful one swaps it.
    const refused = await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), cookie: next }, body: JSON.stringify({ token: "f".repeat(64) }) });
    assert.equal(refused.status, 401); assert.equal(refused.headers["set-cookie"], undefined); assert.equal((await whoami(h, next)).status, 200);
  } finally { await h.close(); }
});

test("two sessions of one person: logout ends only the presented one, log out everywhere ends both, and a replayed cookie stays dead", async () => {
  const h = await start({ rateClasses: wide });
  try {
    await addUser(h, { id: "u-alice", username: "alice", role: "member" });
    const a = await loginAs(h, "alice"); const b = await loginAs(h, "alice");
    assert.notEqual(a.cookie, b.cookie);
    const out = await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie: a.cookie, "x-csrf-token": await csrfToken(h, a.cookie) } });
    assert.equal(out.status, 200);
    assert.equal((await whoami(h, a.cookie)).status, 401, "the server forgot the session, the cookie alone proves nothing");
    assert.equal((await whoami(h, b.cookie)).status, 200, "the other session of the same person lives");
    const c = await loginAs(h, "alice");
    const all = await raw(h, { method: "DELETE", path: "/api/v1/sessions", headers: { cookie: c.cookie, "x-csrf-token": await csrfToken(h, c.cookie) } });
    assert.equal(all.status, 200); assert.equal(all.json.revoked, 2);
    for (const k of [a.cookie, b.cookie, c.cookie]) assert.equal((await whoami(h, k)).status, 401);
    const owner = await login(h); assert.equal((await whoami(h, owner.cookie)).status, 200, "another person's session is untouched");
  } finally { await h.close(); }
});

test("the logout answer clears the cookie with the same attributes the login set, so a browser really drops it", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie, res } = await login(h); const set = res.headers["set-cookie"]![0]!;
    for (const attr of [/; Path=\//, /; HttpOnly/, /; SameSite=Strict/, /; Max-Age=\d+/]) assert.match(set, attr);
    assert.ok(!/Domain=/i.test(set) && !/Secure/i.test(set), "host-only; Secure only over TLS");
    const out = await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie, "x-csrf-token": await csrfToken(h, cookie) } });
    const cleared = out.headers["set-cookie"]![0]!;
    assert.match(cleared, /^plur1bus_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/);
  } finally { await h.close(); }
});

test("at most 64 sessions live at once (oldest first), checked through the HTTP surface", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const cookies: string[] = [];
    for (let i = 0; i < 65; i++) cookies.push((await login(h)).cookie);
    assert.equal((await whoami(h, cookies[0]!)).status, 401, "the oldest was dropped");
    assert.equal((await whoami(h, cookies[1]!)).status, 200);
    assert.equal((await whoami(h, cookies[64]!)).status, 200);
  } finally { await h.close(); }
});

test("KNOWN GAP: the 64-session cap is global, so one account holder can push every other person's session out", { todo: "KNOWN GAP: no per-user session cap; see SICHERHEIT in the PR" }, async () => {
  const h = await start({ rateClasses: wide });
  try {
    await addUser(h, { id: "u-mallory", username: "mallory", role: "viewer" });
    const owner = await login(h);
    for (let i = 0; i < 64; i++) await loginAs(h, "mallory");
    // Wanted: a member's own logins never end the owner's session. Today the owner's session is the oldest and is gone.
    assert.equal((await whoami(h, owner.cookie)).status, 200);
  } finally { await h.close(); }
});

test("a session cookie value the client altered at any single position is a 401, never a 500, and never somebody else's session", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h); const [name, sid] = cookie.split("=") as [string, string];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let i = 0; i < sid.length; i++) {
      const swap = alphabet[(alphabet.indexOf(sid[i]!) + 1) % alphabet.length]!;
      const r = await whoami(h, `${name}=${sid.slice(0, i)}${swap}${sid.slice(i + 1)}`); assert.equal(r.status, 401, `position ${i}`);
    }
    assert.equal((await whoami(h, cookie)).status, 200, "the real value still works after all those misses");
  } finally { await h.close(); }
});

test("empty, extremely long and odd cookie values never produce a 5xx, and the server keeps answering", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h); const name = "plur1bus_session";
    const values: Array<[string, string]> = [
      ["empty", ""], ["blank", " "], ["10 KB", "A".repeat(10_000)], ["semicolon", "a;b"], ["equals", "a=b=c"], ["quote", "\"a\""], ["percent", "%00%41%zz"], ["unicode", "äöü"],
      ["backslash", "\\\\"], ["path-like", "../../etc/passwd"], ["format-like", "%s%s%s%n"], ["json-like", "{\"a\":1}"], ["comma list", "a,b,c"], ["prototype key", "__proto__"], ["constructor", "constructor"],
    ];
    for (const [label, v] of values) {
      const r = await exchange(h.port, rawCookieRequest(h.port, `${name}=${v}`));
      assert.ok(r.status === 401, `${label}: ${r.status}`);
      assert.ok(r.head.includes("X-Content-Type-Options: nosniff"), `${label}: headers on the refusal`);
    }
    // 100 KB is over the header limit: Node refuses it before routing, with the shared headers and no 5xx.
    const big = await exchange(h.port, rawCookieRequest(h.port, `${name}=${"A".repeat(100_000)}`)); assert.equal(big.status, 431); assert.ok(big.head.includes("X-Frame-Options: DENY"));
    // Control bytes in a header value: the HTTP parser refuses, again never a 5xx.
    for (const bad of [Buffer.from(`${name}=a\u0000b`, "latin1"), Buffer.from(`${name}=a\u0001b`, "latin1"), Buffer.from(`${name}=a\u007fb`, "latin1")]) {
      const r = await exchange(h.port, rawCookieRequest(h.port, bad)); assert.ok(r.status === 400 || r.status === 401, `control byte: ${r.status}`); assert.ok(r.head.includes("X-Content-Type-Options: nosniff"));
    }
    assert.equal((await whoami(h, cookie)).status, 200, "the server is still fine and the real session still works");
    assert.ok(!h.logs.some((l) => /"level":"error"/.test(l)), "no handler error was logged for any of them");
  } finally { await h.close(); }
});

test("many cookies and many Cookie headers: the first matching value decides, the rest cannot rescue a bad one", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h);
    const crowd = Array.from({ length: 200 }, (_, i) => `c${i}=v`).join("; ");
    assert.equal((await whoami(h, `${crowd}; ${cookie}`)).status, 200);
    assert.equal((await whoami(h, `plur1bus_session=bad; ${cookie}`)).status, 401);
    const two = await exchange(h.port, Buffer.from(`GET /api/v1/whoami HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nConnection: close\r\nCookie: plur1bus_session=bad\r\nCookie: ${cookie}\r\n\r\n`));
    assert.ok(two.status === 401 || two.status === 400, `two Cookie headers: ${two.status}`);
  } finally { await h.close(); }
});

test("sessions on the same principal differ and carry 256 bits (43 base64url characters); a failed login makes none", async () => {
  const h = await start({ rateClasses: wide });
  try {
    await addUser(h, { id: "u-alice", username: "alice", role: "member" });
    const values = new Set<string>();
    for (let i = 0; i < 20; i++) { const { cookie } = await loginAs(h, "alice"); const v = cookie.split("=")[1]!; assert.match(v, /^[A-Za-z0-9_-]{43}$/); values.add(v); }
    assert.equal(values.size, 20);
    const bad = await loginAs(h, "alice", `${FIXTURE_PASSWORD}-wrong`); assert.equal(bad.res.status, 401); assert.equal(bad.res.headers["set-cookie"], undefined);
  } finally { await h.close(); }
});
