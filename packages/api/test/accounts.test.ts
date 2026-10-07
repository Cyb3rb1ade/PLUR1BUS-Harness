import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RATE_CLASSES } from "../src/rate-limit.ts";
import { ROUTES, type RouteSpec } from "../src/routes.ts";
import { addUser, csrfToken, fakeCore, FIXTURE_PASSWORD, jsonHeaders, login, loginAs, OWNER_TOKEN, raw, start, write, type Harness } from "./helpers.ts";

const wide = { auth: { capacity: 1000, refillPerSec: 100 }, read: { capacity: 1000, refillPerSec: 100 }, write: { capacity: 1000, refillPerSec: 100 }, totp: { capacity: 1000, refillPerSec: 100 }, stream: { capacity: 1000, refillPerSec: 100 } };
const setup = async (o: Parameters<typeof start>[0] = {}) => {
  const h = await start({ rateClasses: wide, ...o });
  await addUser(h, { id: "u-alice", username: "alice", role: "member", agentRights: { main: "use" } });
  await addUser(h, { id: "u-vera", username: "vera", role: "viewer" });
  await addUser(h, { id: "u-olga", username: "olga", role: "operator" });
  return h;
};
const who = (h: Harness, cookie: string) => raw(h, { path: "/api/v1/whoami", headers: { cookie } });

// ---- Q2: password login ----------------------------------------------------------------------------------------

test("a local account logs in with username and password; the principal is the user, the cookie is HttpOnly/SameSite=Strict", async () => {
  const h = await setup();
  try {
    const { cookie, res } = await loginAs(h, "Alice");
    assert.equal(res.status, 200); assert.deepEqual(res.json.principal, { kind: "user", id: "u-alice", role: "member" });
    assert.match(res.headers["set-cookie"]![0]!, /^plur1bus_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict;/);
    assert.deepEqual((await who(h, cookie)).json.principal, { kind: "user", id: "u-alice", role: "member" });
  } finally { await h.close(); }
});

test("unknown name, wrong password and a body mixing both credential kinds never log in; the two real failures look the same", async () => {
  const h = await setup();
  try {
    const a = await loginAs(h, "alice", "wrong"); const b = await loginAs(h, "nobody", FIXTURE_PASSWORD);
    for (const r of [a.res, b.res]) { assert.equal(r.status, 401); assert.equal(r.headers["set-cookie"], undefined); }
    assert.deepEqual(a.res.json, b.res.json);
    assert.equal(a.res.json.reason, "invalid-credentials");
    const mixed = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: OWNER_TOKEN, username: "alice", password: FIXTURE_PASSWORD }) });
    assert.equal(mixed.status, 400);
    const bad = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "alice" }) });
    assert.equal(bad.status, 400);
  } finally { await h.close(); }
});

test("repeated failures lock the name (429 locked, Retry-After) — for a name that does not exist exactly as for one that does", async () => {
  const h = await setup({ lockout: { maxFailures: 3, baseDelayMs: 10_000 } });
  try {
    for (const name of ["alice", "ghost"]) {
      for (let i = 0; i < 3; i++) await loginAs(h, name, "wrong");
      const r = await loginAs(h, name, name === "alice" ? FIXTURE_PASSWORD : "x");
      assert.equal(r.res.status, 429, name); assert.equal(r.res.json.reason, "locked"); assert.equal(r.res.headers["retry-after"], "10"); assert.equal(r.res.headers["set-cookie"], undefined);
    }
    h.clock.advance(10_001);
    assert.equal((await loginAs(h, "alice")).res.status, 200, "the lock ends, the right password works again");
  } finally { await h.close(); }
});

test("the owner token still logs in (bootstrap) and is not mistaken for a password", async () => {
  const h = await setup();
  try {
    const { res } = await login(h); assert.equal(res.status, 200); assert.deepEqual(res.json.principal, { kind: "owner", id: "owner", role: "owner" });
    assert.equal((await loginAs(h, "owner", OWNER_TOKEN)).res.status, 401);
  } finally { await h.close(); }
});

// ---- Q3: sessions ------------------------------------------------------------------------------------------------

test("session fixation: a cookie presented at login is ended and never becomes the logged-in session", async () => {
  const h = await setup();
  try {
    const first = await loginAs(h, "alice");
    const second = await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), cookie: first.cookie }, body: JSON.stringify({ username: "vera", password: FIXTURE_PASSWORD }) });
    assert.equal(second.status, 200);
    const newCookie = second.headers["set-cookie"]![0]!.split(";", 1)[0]!;
    assert.notEqual(newCookie, first.cookie);
    assert.equal((await who(h, first.cookie)).status, 401, "the presented value is dead");
    assert.equal((await who(h, newCookie)).json.principal.id, "u-vera");
    // an attacker-chosen value is not adopted either
    const fixed = "plur1bus_session=attacker-chosen-value";
    const r = await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), cookie: fixed }, body: JSON.stringify({ username: "alice", password: FIXTURE_PASSWORD }) });
    assert.notEqual(r.headers["set-cookie"]![0]!.split(";", 1)[0], fixed); assert.equal((await who(h, fixed)).status, 401);
  } finally { await h.close(); }
});

test("a role change rotates the cookie at the next request: new value, old value dead, CSRF tokens dropped, lifetime not extended", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "alice");
    const t = await csrfToken(h, cookie);
    h.users.change("u-alice", { role: "operator" });
    const r = await who(h, cookie);
    assert.equal(r.status, 200); assert.equal(r.json.principal.role, "operator", "the new role applies at once");
    const next = r.headers["set-cookie"]![0]!;
    const nextCookie = next.split(";", 1)[0]!;
    assert.notEqual(nextCookie, cookie); assert.match(next, /HttpOnly/); assert.match(next, /SameSite=Strict/);
    assert.equal((await who(h, cookie)).status, 401, "the old value is dead");
    assert.equal((await who(h, nextCookie)).status, 200); assert.equal((await who(h, nextCookie)).headers["set-cookie"], undefined, "rotated once, not on every request");
    const w = await raw(h, { method: "DELETE", path: "/api/v1/sessions", headers: { cookie: nextCookie, "x-csrf-token": t } });
    assert.equal(w.status, 403, "a CSRF token from before the rotation does not carry over");
    assert.match(next, /Max-Age=4[0-9]{4}/, "the cookie's remaining lifetime is the session's, not a fresh 12 h");
    assert.equal(h.audit.events.filter((e) => e.action === "auth.session.rotated").length, 1);
  } finally { await h.close(); }
});

test("rightsChanged(userId) rotates that user's sessions and nobody else's", async () => {
  const h = await setup();
  try {
    const a = await loginAs(h, "alice"); const v = await loginAs(h, "vera");
    assert.equal(h.api.rightsChanged("u-alice"), 1);
    assert.ok((await who(h, a.cookie)).headers["set-cookie"]);
    assert.equal((await who(h, v.cookie)).headers["set-cookie"], undefined);
  } finally { await h.close(); }
});

test("a disabled or deleted account loses its session at the next request", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "alice");
    h.users.change("u-alice", { disabled: true });
    const r = await who(h, cookie); assert.equal(r.status, 401); assert.equal(r.json.reason, "session-expired");
    assert.equal((await who(h, cookie)).json.reason, "no-session", "and the session is gone, not just refused");
  } finally { await h.close(); }
});

test("DELETE /sessions ends every session of the caller and only the caller's; the cookie is cleared; the event is audited", async () => {
  const h = await setup();
  try {
    const a1 = await loginAs(h, "alice"); const a2 = await loginAs(h, "alice"); const v = await loginAs(h, "vera");
    const r = await write(h, a1.cookie, { method: "DELETE", path: "/api/v1/sessions" });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { schema: "sessions.revoke-all/1", revoked: 2 }); assert.match(r.headers["set-cookie"]![0]!, /Max-Age=0/);
    assert.equal((await who(h, a1.cookie)).status, 401); assert.equal((await who(h, a2.cookie)).status, 401); assert.equal((await who(h, v.cookie)).status, 200);
    const ev = h.audit.events.find((e) => e.action === "auth.logout-all")!;
    assert.deepEqual([ev.actor.user, ev.detail.revoked], ["u-alice", 2]);
  } finally { await h.close(); }
});

test("logging out everywhere needs the CSRF token like any write", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "alice");
    assert.equal((await raw(h, { method: "DELETE", path: "/api/v1/sessions", headers: { cookie } })).status, 403);
    assert.equal((await who(h, cookie)).status, 200);
  } finally { await h.close(); }
});

// ---- Q7: deny by default ----------------------------------------------------------------------------------------

const SELF_SERVICE = ["csrf.issue", "session.delete", "sessions.revoke-all", "whoami"];

test("the routes that need no role are exactly the session self-service routes, nothing else", () => {
  assert.deepEqual(ROUTES.filter((r) => r.authz === "authenticated").map((r) => r.id).sort(), SELF_SERVICE);
  assert.deepEqual(ROUTES.filter((r) => r.authz === "public").map((r) => r.id), ["session.create", "session.totp"], "the two login steps");
  for (const r of ROUTES) assert.ok(r.authz !== undefined, `${r.id} declares an authorization`);
});

test("every route: unauthenticated is 401; a Viewer is refused on every route that needs a role (reads and writes)", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "vera");
    for (const r of ROUTES.filter((x) => x.auth !== "none")) {
      const anon = await raw(h, { method: r.method, path: r.path, headers: jsonHeaders() });
      assert.equal(anon.status, 401, `anon ${r.id}`);
      if (typeof r.authz !== "object") continue;
      const t = r.csrf ? await csrfToken(h, cookie) : undefined;
      const res = await raw(h, { method: r.method, path: r.path, headers: { cookie, ...(t ? { "x-csrf-token": t } : {}) } });
      const viewerMayRead = r.method === "GET" && ["agents.list", "tokens.list", "totp.status", "notices.list"].includes(r.id); // agent.list is open to all roles; my.read is "own" for all
      assert.equal(res.status, viewerMayRead ? 200 : 403, `viewer ${r.id}`);
    }
    assert.equal(h.core.calls.filter((c) => c.method !== "agent.list").length, 0, "a refused request never reaches the core");
  } finally { await h.close(); }
});

test("a route that declares no authorization is refused for everyone, the owner included, and its handler never runs", async () => {
  let ran = 0;
  const bare: RouteSpec = { id: "t.bare", method: "GET", path: "/api/v1/_t/bare", summary: "x", tag: "t", auth: "session", csrf: false, rate: "read", stability: "experimental", since: "0", successStatus: 200, success: { description: "", schema: {} } } as unknown as RouteSpec;
  const bareOpen: RouteSpec = { ...bare, id: "t.bare-open", path: "/api/v1/_t/bare-open", auth: "none" };
  const h = await setup({ extraRoutes: [{ spec: bare, handler: () => { ran++; return { body: { ok: true } }; } }, { spec: bareOpen, handler: () => { ran++; return { body: { ok: true } }; } }] });
  try {
    const { cookie } = await login(h);
    const r = await raw(h, { path: "/api/v1/_t/bare", headers: { cookie } });
    assert.deepEqual([r.status, r.json.reason], [403, "undeclared-route"]);
    const open = await raw(h, { path: "/api/v1/_t/bare-open" });
    assert.deepEqual([open.status, open.json.reason], [403, "undeclared-route"]);
    assert.equal(ran, 0);
  } finally { await h.close(); }
});

test("operator reads health (doctor.read); viewer and member do not", async () => {
  const h = await setup();
  try {
    for (const [name, status] of [["olga", 200], ["vera", 403], ["alice", 403]] as const) {
      const { cookie } = await loginAs(h, name);
      assert.equal((await raw(h, { path: "/api/v1/health", headers: { cookie } })).status, status, name);
    }
  } finally { await h.close(); }
});

test("a member sees only the agents they hold a right on; a viewer without rights sees none; the owner sees all (acceptance 3)", async () => {
  const core = fakeCore();
  core.impl = async (m) => { if (m === "agent.list") return { agents: [{ agentId: "main", open: true, activity: { state: "idle", since: 1 } }, { agentId: "secret", open: false, activity: { state: "idle", since: 2 } }] }; throw new Error(m); };
  const h = await setup({ core });
  try {
    const ids = async (cookie: string) => (await raw(h, { path: "/api/v1/agents", headers: { cookie } })).json.agents.map((a: { agentId: string }) => a.agentId);
    assert.deepEqual(await ids((await loginAs(h, "alice")).cookie), ["main"]);
    assert.deepEqual(await ids((await loginAs(h, "vera")).cookie), []);
    assert.deepEqual(await ids((await login(h)).cookie), ["main", "secret"]);
    assert.deepEqual(await ids((await loginAs(h, "olga")).cookie), ["main", "secret"], "operator: agent.read is a role grant");
  } finally { await h.close(); }
});

test("a demotion applies at once: a member made viewer loses the agent they could see", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "alice");
    const before = (await raw(h, { path: "/api/v1/agents", headers: { cookie } })).json.agents.length;
    h.users.change("u-alice", { role: "viewer", agentRights: {} });
    const after = await raw(h, { path: "/api/v1/agents", headers: { cookie } });
    assert.deepEqual([before, after.json.agents.length], [1, 0]);
  } finally { await h.close(); }
});

test("a refused write is audited with the action and reason, no body, no secret; a refused read is not", async () => {
  const spec = (id: string, method: "GET" | "POST"): RouteSpec => ({ id, method, path: `/api/v1/_t/${id}`, summary: "x", tag: "t", auth: "session", authz: { action: "settings.write" }, csrf: method === "POST", rate: "write", stability: "experimental", since: "0", successStatus: 200, success: { description: "", schema: {} } });
  const ok = () => ({ body: { ok: true } });
  const h = await setup({ extraRoutes: [{ spec: spec("w", "POST"), handler: ok }, { spec: spec("r", "GET"), handler: ok }] });
  try {
    const { cookie } = await loginAs(h, "alice");
    assert.equal((await write(h, cookie, { path: "/api/v1/_t/w", body: { password: "x" } })).status, 403);
    assert.equal((await raw(h, { path: "/api/v1/_t/r", headers: { cookie } })).status, 403);
    const denied = h.audit.events.filter((e) => e.action === "auth.denied");
    assert.equal(denied.length, 1);
    assert.deepEqual([denied[0]!.actor.user, denied[0]!.target, denied[0]!.detail.action, denied[0]!.detail.reason], ["u-alice", "route:w", "settings.write", "role-denied"]);
    assert.ok(!JSON.stringify(h.audit.events).includes(FIXTURE_PASSWORD));
  } finally { await h.close(); }
});

// ---- Q10 (login part): audit ----------------------------------------------------------------------------------

test("login success, failure and logout are audited without the typed name, the password or the cookie", async () => {
  const h = await setup();
  try {
    await loginAs(h, "alice", "wrong-fixture-1");
    await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: "b".repeat(64) }) });
    const { cookie } = await loginAs(h, "alice");
    await write(h, cookie, { method: "DELETE", path: "/api/v1/session" });
    const acts = h.audit.events.map((e) => e.action);
    assert.deepEqual(acts, ["auth.login.failure", "auth.login.failure", "auth.login.success", "auth.logout"]);
    const text = JSON.stringify(h.audit.events);
    for (const secret of ["wrong-fixture-1", FIXTURE_PASSWORD, cookie.split("=")[1]!, "\"alice\"", "b".repeat(64)]) assert.ok(!text.includes(secret), `no ${secret.slice(0, 8)}… in the audit`);
    assert.match(h.audit.events[0]!.target, /^name:[0-9a-f]{16}$/);
    assert.deepEqual([h.audit.events[2]!.actor.user, h.audit.events[2]!.target], ["u-alice", "user:u-alice"]);
  } finally { await h.close(); }
});

test("rate-limit hits are audited once per window, not once per refused request", async () => {
  const h = await setup({ rateClasses: { ...DEFAULT_RATE_CLASSES, auth: { capacity: 2, refillPerSec: 0.001 } } });
  try {
    for (let i = 0; i < 12; i++) await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: "b".repeat(64) }) });
    assert.equal(h.audit.events.filter((e) => e.action === "auth.rate-limited").length, 1);
  } finally { await h.close(); }
});
