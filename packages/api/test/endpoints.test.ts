import assert from "node:assert/strict";
import test from "node:test";
import { fakeCore, login, raw, start } from "./helpers.ts";

test("GET /api/v1/agents returns the core's agent.list value with a schema id", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h);
    const r = await raw(h, { path: "/api/v1/agents", headers: { cookie } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { schema: "agents.list/1", agents: [{ agentId: "main", open: true, activity: { state: "idle", since: 1 } }] });
    assert.deepEqual(h.core.calls, [{ method: "agent.list" }]);
  } finally { await h.close(); }
});

test("agents: a core that is down is 503 E_CORE_UNAVAILABLE; a core error keeps its code; an internal core fault is a 502 without its text", async () => {
  const core = fakeCore(); const h = await start({ core });
  try {
    const { cookie } = await login(h);
    core.impl = async () => { throw Object.assign(new Error("connect ECONNREFUSED /home/u/run/core.sock"), { code: "ECONNREFUSED" }); };
    let r = await raw(h, { path: "/api/v1/agents", headers: { cookie } });
    assert.deepEqual([r.status, r.json.error, r.json.reason], [503, "E_CORE_UNAVAILABLE", "core-unreachable"]); assert.ok(!r.text.includes("/home/u"));
    core.impl = async () => { throw Object.assign(new Error("unknown agent"), { error: "E_AGENT_UNKNOWN" }); };
    r = await raw(h, { path: "/api/v1/agents", headers: { cookie } });
    assert.deepEqual([r.status, r.json.error], [404, "E_AGENT_UNKNOWN"]);
    core.impl = async () => { throw Object.assign(new Error("TypeError at /srv/x.js:3"), { error: "E_INTERNAL" }); };
    r = await raw(h, { path: "/api/v1/agents", headers: { cookie } });
    assert.deepEqual([r.status, r.json.error], [502, "E_CORE_UNAVAILABLE"]); assert.ok(!r.text.includes("/srv/x.js"));
  } finally { await h.close(); }
});

test("GET /api/v1/health: ok, degraded while the engine warms or reports a degradation, down (503) when the core does not answer", async () => {
  const core = fakeCore(); const h = await start({ core, limits: { healthTimeoutMs: 100 } });
  try {
    const { cookie } = await login(h);
    let r = await raw(h, { path: "/api/v1/health", headers: { cookie } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { schema: "health/1", status: "ok", api: { version: "1.0.0" }, core: { reachable: true, rpc: "1.5.0", contract: "7.18.4", uptimeMs: 1234, engineReady: true, degraded: false } });
    const status = (engine: object) => async () => ({ rpc: "1.5.0", contract: "c", uptimeMs: 1, engine });
    core.impl = status({ ready: false, degraded: null }); r = await raw(h, { path: "/api/v1/health", headers: { cookie } });
    assert.deepEqual([r.status, r.json.status, r.json.core.engineReady], [200, "degraded", false]);
    core.impl = status({ ready: true, degraded: { reason: "models-warming" } }); r = await raw(h, { path: "/api/v1/health", headers: { cookie } });
    assert.deepEqual([r.status, r.json.status, r.json.core.degraded], [200, "degraded", true]);
    core.impl = async () => { throw new Error("down"); }; r = await raw(h, { path: "/api/v1/health", headers: { cookie } });
    assert.deepEqual(r.json, { schema: "health/1", status: "down", api: { version: "1.0.0" }, core: { reachable: false } }); assert.equal(r.status, 503);
    core.impl = () => new Promise(() => {}); r = await raw(h, { path: "/api/v1/health", headers: { cookie } });
    assert.equal(r.status, 503, "a core that hangs is down after healthTimeoutMs, not after the handler timeout");
  } finally { await h.close(); }
});

test("whoami reports the principal and the session's times", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h);
    const r = await raw(h, { path: "/api/v1/whoami", headers: { cookie } });
    assert.deepEqual(r.json.principal, { kind: "owner", id: "owner", role: "owner" });
    for (const k of ["createdAt", "expiresAt", "idleExpiresAt"]) assert.ok(!Number.isNaN(Date.parse(r.json.session[k])), k);
    assert.ok(Date.parse(r.json.session.expiresAt) > Date.parse(r.json.session.idleExpiresAt));
  } finally { await h.close(); }
});

test("unknown paths are 404, wrong methods 405 with Allow; query strings and trailing slashes do not match other routes", async () => {
  const h = await start();
  try {
    const { cookie } = await login(h);
    assert.equal((await raw(h, { path: "/api/v1/nope", headers: { cookie } })).status, 404);
    assert.equal((await raw(h, { path: "/api/v2/whoami", headers: { cookie } })).status, 404);
    assert.equal((await raw(h, { path: "/api/v1/whoami/", headers: { cookie } })).status, 404);
    assert.equal((await raw(h, { path: "/api/v1/whoami?x=1", headers: { cookie } })).status, 200);
    const r = await raw(h, { method: "POST", path: "/api/v1/whoami", headers: { cookie } });
    assert.equal(r.status, 405); assert.equal(r.headers.allow, "GET");
    assert.equal((await raw(h, { method: "PUT", path: "/api/v1/session", headers: { cookie } })).headers.allow, "POST, DELETE");
  } finally { await h.close(); }
});
