import assert from "node:assert/strict";
import test from "node:test";
import type { RouteSpec } from "../src/routes.ts";
import { addUser, fakeCore, FIXTURE_PASSWORD, jsonHeaders, login, loginAs, raw, start, write, type Harness } from "./helpers.ts";

const wide = { auth: { capacity: 1000, refillPerSec: 100 }, read: { capacity: 1000, refillPerSec: 100 }, write: { capacity: 1000, refillPerSec: 100 }, totp: { capacity: 1000, refillPerSec: 100 }, stream: { capacity: 1000, refillPerSec: 100 } };
const ok = () => ({ body: { ok: true } });
const spec = (id: string, method: "GET" | "POST", action: string): RouteSpec => ({ id, method, path: `/api/v1/_t/${id}`, summary: "x", tag: "t", auth: "any", authz: { action }, csrf: false, rate: method === "GET" ? "read" : "write", stability: "experimental", since: "0", successStatus: 200, success: { description: "", schema: {} } });
const EXTRA = [
  { spec: spec("settings-write", "POST", "settings.write"), handler: ok },
  { spec: spec("grant-read", "GET", "grant.read"), handler: ok },
];
const setup = async (o: Parameters<typeof start>[0] = {}) => {
  const core = fakeCore();
  core.impl = async (m) => { if (m === "agent.list") return { agents: [{ agentId: "main", open: true, activity: { state: "idle", since: 1 } }, { agentId: "other", open: true, activity: { state: "idle", since: 2 } }] }; if (m === "core.status") return { rpc: "1.5.0", contract: "c", uptimeMs: 1, engine: { ready: true, degraded: null } }; throw new Error(m); };
  const h = await start({ rateClasses: wide, extraRoutes: EXTRA, core, ...o });
  await addUser(h, { id: "u-mia", username: "mia", role: "member", agentRights: { main: "use" } });
  await addUser(h, { id: "u-olga", username: "olga", role: "operator" });
  await addUser(h, { id: "u-adam", username: "adam", role: "admin" });
  await addUser(h, { id: "u-vera", username: "vera", role: "viewer" });
  return h;
};
const mint = async (h: Harness, cookie: string, scopes: string[], extra: Record<string, unknown> = {}) => {
  const r = await write(h, cookie, { path: "/api/v1/tokens", body: { name: "t", scopes, ...extra } });
  assert.equal(r.status, 201, r.text); return r.json as { token: string; record: { id: string; prefix: string } };
};
const bearer = (h: Harness, token: string, o: { method?: string; path: string; body?: unknown } = { path: "/api/v1/whoami" }) =>
  raw(h, { method: o.method ?? "GET", path: o.path, headers: { authorization: `Bearer ${token}`, ...(o.body !== undefined ? jsonHeaders() : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });

test("a token is made over a session with a CSRF token, shown once, never listed with its secret", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const made = await mint(h, cookie, ["agent.*"], { ttlDays: 30 });
    assert.equal(made.record.prefix, `plb_${made.record.id}`);
    assert.match(made.token, /^plb_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    const list = await raw(h, { path: "/api/v1/tokens", headers: { cookie } });
    assert.equal(list.json.tokens.length, 1); assert.ok(!list.text.includes(made.token.slice(17)));
    assert.deepEqual(list.json.tokens[0].scopes, ["agent.*"]);
    assert.equal(Date.parse(list.json.tokens[0].expiresAt) - Date.parse(list.json.tokens[0].createdAt), 30 * 86_400_000);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/tokens", headers: { cookie, ...jsonHeaders() }, body: JSON.stringify({ name: "x", scopes: ["agent.*"] }) })).status, 403, "no CSRF token, no token");
  } finally { await h.close(); }
});

test("bad bodies are 400s with a reason: scope, name, ttl, shape; a viewer cannot make tokens at all", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const post = (body: unknown) => write(h, cookie, { path: "/api/v1/tokens", body });
    assert.equal((await post({ name: "x", scopes: ["root"] })).json.reason, "scope");
    assert.equal((await post({ name: "x", scopes: [] })).json.reason, "scope");
    assert.equal((await post({ name: "", scopes: ["agent.read"] })).json.reason, "name");
    assert.equal((await post({ name: "x", scopes: ["agent.read"], ttlDays: 0 })).json.reason, "ttl");
    assert.equal((await post({ name: "x", scopes: ["agent.read"], ttlDays: 1.5 })).json.reason, "ttl");
    for (const b of [{ scopes: ["agent.read"] }, { name: "x" }, { name: "x", scopes: ["agent.read"], admin: true }, [], null]) assert.equal((await post(b)).json.reason, "body", JSON.stringify(b));
    const v = await loginAs(h, "vera");
    assert.equal((await write(h, v.cookie, { path: "/api/v1/tokens", body: { name: "x", scopes: ["agent.read"] } })).status, 403);
  } finally { await h.close(); }
});

test("a token authenticates with Authorization: Bearer, needs no CSRF token, and whoami says it came in by token", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const { token, record } = await mint(h, cookie, ["agent.*"]);
    const r = await bearer(h, token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.principal, { kind: "user", id: "u-mia", role: "member" });
    assert.equal(r.json.via, "token"); assert.deepEqual([r.json.token.id, r.json.token.scopes], [record.id, ["agent.*"]]); assert.equal(r.json.session, undefined);
    assert.ok(!r.text.includes(token.slice(17)));
    const agents = await bearer(h, token, { path: "/api/v1/agents" });
    assert.deepEqual(agents.json.agents.map((a: { agentId: string }) => a.agentId), ["main"], "the member's object rights still apply through the token");
  } finally { await h.close(); }
});

test("a token can never be more than its user's role (acceptance 5): a member's settings.write token is still refused", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const { token } = await mint(h, cookie, ["settings.write", "settings.*"]);
    const r = await bearer(h, token, { method: "POST", path: "/api/v1/_t/settings-write", body: {} });
    assert.equal(r.status, 403); assert.equal(r.json.reason, "role-denied");
    const a = await loginAs(h, "adam");
    const adminToken = (await mint(h, a.cookie, ["settings.write"])).token;
    assert.equal((await bearer(h, adminToken, { method: "POST", path: "/api/v1/_t/settings-write", body: {} })).status, 200, "an admin's token with that scope can");
  } finally { await h.close(); }
});

test("scopes only narrow: an operator's doctor.read token reads health but not agents; the same operator's session does both", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "olga");
    const { token } = await mint(h, cookie, ["doctor.read"]);
    assert.equal((await bearer(h, token, { path: "/api/v1/health" })).status, 200);
    const agents = await bearer(h, token, { path: "/api/v1/agents" });
    assert.equal(agents.status, 403); assert.equal(agents.json.reason, "token-scope");
    assert.equal((await raw(h, { path: "/api/v1/agents", headers: { cookie } })).status, 200);
  } finally { await h.close(); }
});

test("a demotion shrinks the token with the user: an operator's token loses doctor.read when the operator becomes a viewer", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "olga");
    const { token } = await mint(h, cookie, ["doctor.read"]);
    assert.equal((await bearer(h, token, { path: "/api/v1/health" })).status, 200);
    h.users.change("u-olga", { role: "viewer" });
    assert.equal((await bearer(h, token, { path: "/api/v1/health" })).status, 403);
    h.users.change("u-olga", { disabled: true });
    assert.equal((await bearer(h, token, { path: "/api/v1/health" })).status, 401, "a disabled account's tokens are dead");
  } finally { await h.close(); }
});

test("a token acts as an agent principal: a human-only action (grant.read) is refused to an admin's token and allowed to the admin's session", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "adam");
    assert.equal((await raw(h, { path: "/api/v1/_t/grant-read", headers: { cookie } })).status, 200);
    const { token } = await mint(h, cookie, ["grant.*"]);
    const r = await bearer(h, token, { path: "/api/v1/_t/grant-read" });
    assert.equal(r.status, 403); assert.equal(r.json.reason, "agent-principal");
  } finally { await h.close(); }
});

test("revoking ends a token at once; revoking someone else's token or an unknown id is the same 404", async () => {
  const h = await setup();
  try {
    const mia = await loginAs(h, "mia"); const olga = await loginAs(h, "olga");
    const { token, record } = await mint(h, mia.cookie, ["agent.*"]);
    assert.equal((await bearer(h, token)).status, 200);
    const foreign = await write(h, olga.cookie, { path: "/api/v1/tokens/revoke", body: { id: record.id } });
    const unknown = await write(h, olga.cookie, { path: "/api/v1/tokens/revoke", body: { id: "000000000000" } });
    assert.deepEqual([foreign.status, foreign.json.reason, foreign.json.message], [unknown.status, unknown.json.reason, unknown.json.message]); assert.equal(foreign.status, 404);
    assert.equal((await bearer(h, token)).status, 200, "still alive");
    assert.equal((await write(h, mia.cookie, { path: "/api/v1/tokens/revoke", body: { id: record.id } })).status, 200);
    const dead = await bearer(h, token); assert.equal(dead.status, 401); assert.equal(dead.json.reason, "invalid-token");
    assert.equal((await write(h, mia.cookie, { path: "/api/v1/tokens/revoke", body: { id: record.id } })).status, 404, "twice is a 404");
    assert.equal((await write(h, mia.cookie, { path: "/api/v1/tokens/revoke", body: { id: "short" } })).status, 400);
  } finally { await h.close(); }
});

test("an expired token is 401 on the injected clock", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const { token } = await mint(h, cookie, ["agent.*"], { ttlDays: 1 });
    h.clock.advance(86_400_000 - 1); assert.equal((await bearer(h, token)).status, 200);
    h.clock.advance(2); assert.equal((await bearer(h, token)).status, 401);
  } finally { await h.close(); }
});

test("a token cannot mint, list or revoke tokens, fetch a CSRF token or log out: those routes take the session cookie only", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const { token } = await mint(h, cookie, ["my.*", "agent.*"]);
    for (const [method, path] of [["GET", "/api/v1/tokens"], ["POST", "/api/v1/tokens"], ["POST", "/api/v1/tokens/revoke"], ["GET", "/api/v1/csrf"], ["DELETE", "/api/v1/session"], ["DELETE", "/api/v1/sessions"]] as const) {
      const r = await raw(h, { method, path, headers: { authorization: `Bearer ${token}`, ...jsonHeaders() }, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(r.status, 401, `${method} ${path}`); assert.equal(r.json.reason, "no-session");
    }
  } finally { await h.close(); }
});

test("a bad Bearer value is a 401 even with a valid cookie (no fallback); Basic and other schemes are not tokens", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    for (const authorization of ["Bearer plb_000000000000_" + "A".repeat(43), "Bearer nonsense", "Bearer ", "bearer", "BEARER x"]) { // the word Bearer means a token: an empty or odd one is refused, not ignored
      const r = await raw(h, { path: "/api/v1/whoami", headers: { cookie, authorization } });
      assert.equal(r.status, 401, authorization.slice(0, 20)); assert.equal(r.json.reason, "invalid-token");
    }
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie, authorization: "Basic abc" } })).status, 200, "Basic is ignored, the cookie is used");
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { authorization: "Basic abc" } })).status, 401);
  } finally { await h.close(); }
});

test("the installation owner (owner-token login) can make and use tokens; they carry the owner role", async () => {
  const h = await setup();
  try {
    const { cookie } = await login(h);
    const { token } = await mint(h, cookie, ["doctor.read"]);
    const r = await bearer(h, token, { path: "/api/v1/health" }); assert.equal(r.status, 200);
    assert.deepEqual((await bearer(h, token)).json.principal, { kind: "owner", id: "owner", role: "owner" });
  } finally { await h.close(); }
});

test("a token that runs its bucket dry is answered 429 with Retry-After, and the refusal is audited once", async () => {
  const h = await setup({ rateClasses: { ...wide, read: { capacity: 3, refillPerSec: 0.001 } } });
  try {
    const { cookie } = await loginAs(h, "mia");
    const { token } = await mint(h, cookie, ["agent.*"]);
    h.clock.advance(10_000_000); // everything starts full again
    const seen: number[] = []; let last;
    for (let i = 0; i < 6; i++) { last = await bearer(h, token); seen.push(last.status); }
    assert.deepEqual(seen.slice(0, 3), [200, 200, 200]); assert.ok(seen.slice(3).every((x) => x === 429), JSON.stringify(seen));
    assert.match(last!.headers["retry-after"] as string, /^\d+$/); assert.equal(last!.json.reason, "rate-limited");
    assert.equal(h.audit.events.filter((e) => e.action === "auth.rate-limited").length, 1);
  } finally { await h.close(); }
});

test("the audit holds token creation, revocation and refused tokens — and no secret, no hash, no header", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const { token, record } = await mint(h, cookie, ["agent.*"]);
    await bearer(h, "plb_000000000000_" + "A".repeat(43)); await bearer(h, "plb_000000000000_" + "A".repeat(43));
    await write(h, cookie, { path: "/api/v1/tokens/revoke", body: { id: record.id } });
    await bearer(h, token);
    const acts = h.audit.events.map((e) => e.action).filter((x) => x.startsWith("auth.token"));
    assert.deepEqual(acts, ["auth.token.created", "auth.token.used-denied", "auth.token.revoked", "auth.token.used-denied"], "two unknown-token tries are one event; the revoked token's use is its own");
    const created = h.audit.events.find((e) => e.action === "auth.token.created")!;
    assert.deepEqual([created.actor.user, created.target, created.detail.scopes], ["u-mia", `token:${record.id}`, ["agent.*"]]);
    const text = JSON.stringify(h.audit.events) + h.logs.join("\n");
    assert.ok(!text.includes(token.slice(17)) && !text.includes(FIXTURE_PASSWORD) && !text.includes("Bearer "), "no secret and no Authorization header in audit or log");
    assert.equal(h.audit.events.filter((e) => e.action === "auth.token.used-denied" && e.target === "token:-").length, 1, "the unknown-token flood is one event per window");
  } finally { await h.close(); }
});
