import test from "node:test";
import assert from "node:assert/strict";
import { ROUTES } from "../src/routes.ts";
import { RPC_RULES } from "../../core/src/rbac/guard.ts";
import { authorize, policyFor } from "../src/rbac-bridge.ts";
import { start, fakeCore, addUser, raw, jsonHeaders, loginAs, write } from "./helpers.ts";
const wide = { auth: { capacity: 10000, refillPerSec: 1000 }, read: { capacity: 10000, refillPerSec: 1000 }, write: { capacity: 10000, refillPerSec: 1000 }, stream: { capacity: 10000, refillPerSec: 1000 } };
const publicIds = new Set(["desktop.meta", "desktop.pair", "desktop.redeem", "desktop.ticket", "desktop.step-up.start", "desktop.step-up.poll", "desktop.step-up.cancel", "invitation.redeem", "session.create", "session.totp", "account.bootstrap", "passkeys.login.options", "passkeys.login", "remote.pair-proof", "remote.device.pair", "oauth.metadata", "oauth.protected_resource", "oauth.authorize.get", "oauth.authorize.post", "oauth.token", "oauth.revoke", "a2a.card.root", "a2a.card.root.alias", "a2a.card.agent", "a2a.card.agent.alias"]);
const selfIds = new Set(["csrf.issue", "session.delete", "sessions.revoke-all", "whoami", "desktop.step-up.approval", "desktop.step-up.decision", "oauth.grants.list", "oauth.grants.revoke"]);
const path = (value: string) => value.replace("{agentId}", "main").replace("{sessionId}", "deny-contract");
const body = (id: string) => id === "chats.create" ? { agentId: "main" } : id === "chats.submit" ? { text: "Deny contract" } : {};
test("every registered route has a reviewed auth classification and anonymous requests cannot enter authenticated routes", async t => {
  const h = await start({ rateClasses: wide }); t.after(() => h.close());
  for (const r of ROUTES) {
    assert.ok(r.authz, `${r.id} must declare authorization`);
    if (r.authz === "public") { assert.ok(publicIds.has(r.id), `${r.id} is an unreviewed public route`); assert.equal(r.auth, "none"); continue; }
    if (r.authz === "authenticated") assert.ok(selfIds.has(r.id), `${r.id} is unreviewed session self-service`);
    else if (r.authz === "delegated") assert.ok(["web.rpc", "web.events", "mcp.server", "a2a.endpoint"].includes(r.id), `${r.id} is unreviewed delegated route`);
    else assert.ok(policyFor(r.authz.action), `${r.id} needs a registered policy`);
    const res = await raw(h, { method: r.method, path: path(r.path), headers: r.requestBody ? jsonHeaders() : {}, ...(r.requestBody ? { body: JSON.stringify(body(r.id)) } : {}) });
    assert.equal(res.status, 401, `${r.id} anonymous with a valid path`);
  }
});
test("Viewer cannot mutate business routes; logout/CSRF are explicit self-service and RPC delegates method authorization", async t => {
  const core = fakeCore();
  // /rpc is a method multiplexer; application refusals remain HTTP 200 and come from the real method policy.
  core.callAs = async (method, params, principal) => {
    const u = await h.users.findById(principal.userId), rule = RPC_RULES[method];
    assert.ok(u); assert.ok(rule); const decision = authorize({ userId: u.id, kind: "person", role: u.role }, rule.action, rule.resource(params));
    if (decision.effect === "deny") throw { error: "E_DENIED", reason: "role-denied" }; throw new Error("Viewer write unexpectedly authorized");
  };
  const h = await start({ core, rateClasses: wide }); t.after(() => h.close()); await addUser(h, { id: "viewer-deny", username: "viewerdeny", role: "viewer" }); const { cookie } = await loginAs(h, "viewerdeny");
  for (const r of ROUTES.filter(r => r.auth !== "none" && r.method !== "GET" && typeof r.authz === "object" && r.authz.action !== "chat:read")) {
    const res = await write(h, cookie, { method: r.method, path: path(r.path), ...(r.requestBody ? { body: body(r.id) } : {}) });
    assert.equal(res.status, 403, `${r.id} Viewer write`); assert.equal(res.json.reason, "role-denied", `${r.id} must deny authority before Core`);
  }
  const rpc = await write(h, cookie, { path: "/rpc", body: { jsonrpc: "2.0", id: 1, method: "agent.pause", params: { agentId: "main", principal: { role: "owner" } } } });
  assert.equal(rpc.status, 200); assert.equal(rpc.json.error.data.error, "E_DENIED"); assert.equal(rpc.json.error.data.reason, "role-denied");
  assert.equal(h.core.calls.length, 0);
});
test("chat:read personal token cannot write; a full-scope token cannot exceed a demoted user's Viewer role", async t => {
  const h = await start({ rateClasses: wide }); t.after(() => h.close()); await addUser(h, { id: "token-deny", username: "tokendeny", role: "member" }); const { cookie } = await loginAs(h, "tokendeny");
  const create = async (scopes: string[]) => { const r = await write(h, cookie, { path: "/api/v1/tokens", body: { name: "Contract", scopes } }); assert.equal(r.status, 201); return r.json.token as string; };
  const readOnly = await create(["chat:read"]), full = await create(["chat:read", "chat:write", "chat:delete"]);
  for (const r of ROUTES.filter(r => r.id.startsWith("chats.") && typeof r.authz === "object" && r.authz.action !== "chat:read")) {
    const response = await raw(h, { method: r.method, path: path(r.path), headers: { authorization: `Bearer ${readOnly}`, ...jsonHeaders() }, body: JSON.stringify(body(r.id)) }); assert.equal(response.status, 403, `${r.id} read scope`);
  }
  h.users.change("token-deny", { role: "viewer" });
  for (const r of ROUTES.filter(r => r.id.startsWith("chats.") && ["chat:write", "chat:delete"].includes(typeof r.authz === "object" ? r.authz.action : ""))) {
    const response = await raw(h, { method: r.method, path: path(r.path), headers: { authorization: `Bearer ${full}`, ...jsonHeaders() }, body: JSON.stringify(body(r.id)) }); assert.equal(response.status, 403, `${r.id} token cannot exceed live Viewer role`);
  }
  assert.equal(h.core.calls.length, 0);
});

test("remote pairing authority and trust acknowledgement cannot be exercised with personal tokens", async t => {
  const h = await start({ rateClasses: wide }); t.after(() => h.close());
  await addUser(h, { id: "remote-token", username: "remotetoken", role: "admin" });
  const { cookie } = await loginAs(h, "remotetoken");
  const issued = await write(h, cookie, { path: "/api/v1/tokens", body: { name: "Remote probe", scopes: ["device.*", "remote.*", "admin.*", "settings.*"] } });
  assert.equal(issued.status, 201);
  for (const r of ROUTES.filter(r => r.id.startsWith("remote.") && r.auth !== "none")) {
    const response = await raw(h, { method: r.method, path: r.path, headers: { authorization: `Bearer ${issued.json.token}`, ...(r.requestBody ? jsonHeaders() : {}) }, ...(r.requestBody ? { body: JSON.stringify(body(r.id)) } : {}) });
    assert.ok([401, 403].includes(response.status), `${r.id}: personal token reached remote controller (${response.status})`);
  }
  assert.equal(h.core.calls.length, 0);
});
