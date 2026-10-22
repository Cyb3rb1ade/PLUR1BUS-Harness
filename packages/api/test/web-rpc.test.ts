import { guardMethods } from "../../core/src/rbac/guard.ts";
import { SessionStore, OWNER } from "../src/session.ts";
import { FakeClock } from "../src/clock.ts";
import { webPrincipal, webConnection, forgetWebConnection } from "../src/principal.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { METHODS_BY_SERVER } from "@plur1bus/rpc-schema";
import { WEB_CORE_METHODS, WEB_SUPERVISOR_METHODS, rpcRoute, webEndpoint } from "../src/rpc-route.ts";
import { RPC_RULES } from "../src/rbac-bridge.ts";
import { EXPENSIVE_RPC_METHODS } from "../src/rate-limit.ts";
import { webEventAllowed } from "../src/events-route.ts";
import { start, raw, login, csrfToken } from "./helpers.ts";
import type { CoreRpc } from "../src/core-rpc.ts";
const person = { userId: "alice", kind: "person", role: "member" } as const;

test("explicit web exposure rejects internal and unrelated supervisor methods", () => {
  for (const m of ["core.auth", "core.adopt", "core.shutdown", "supervisor.auth", "daemon.stop", "config.watch", "module.watch", "events.subscribe", "admin.backup.snapshot", "secret.get", "memory.capture", "api.unknown"]) assert.equal(webEndpoint(m), null, m);
  assert.equal(webEndpoint("inbox.list"), "core"); assert.equal(webEndpoint("config.set"), "supervisor");
});
test("every exposed method is declared on its routed server", () => {
  for (const method of WEB_CORE_METHODS) assert.ok(METHODS_BY_SERVER.core.includes(method), method);
  for (const method of WEB_SUPERVISOR_METHODS) assert.ok(METHODS_BY_SERVER.supervisor.includes(method), method);
});
const ID = "00000000-0000-4000-8000-000000000001";
const LIBRARY_MEDIA_CALLS: Record<string, object> = {
  "media.output.list": {}, "media.output.get": { id: ID }, "media.output.delete": { id: ID }, "media.adapters.list": {},
  "media.preferences.get": {}, "media.preferences.set": { embedMetadata: true },
  "media.generate": { agentId: "main", request: { prompt: "a cat" } }, "media.edit": { agentId: "main", request: { prompt: "a cat" } },
  "media.job.get": { id: ID }, "media.job.list": {}, "media.job.cancel": { id: ID },
  "media.index.status": {}, "media.index.pause": {}, "media.index.resume": {}, "media.index.reindex": { confirm: true },
};
test("every media.* method the Library and Memory pages call is web-callable, routed to the core and covered by an RBAC rule", async () => {
  for (const [method, params] of Object.entries(LIBRARY_MEDIA_CALLS)) {
    assert.equal(webEndpoint(method), "core", method);
    assert.ok(RPC_RULES[method], `${method} needs an RBAC rule before it may be exposed`);
    let got: unknown;
    const core: CoreRpc = { call: async () => { throw new Error("legacy path"); }, callAs: async (m, p, who, endpoint) => { got = { m, p, who, endpoint }; return {} as never; } };
    const answer = await rpcRoute(core, { jsonrpc: "2.0", id: 1, method, params }, person);
    assert.ok("result" in answer, `${method}: ${JSON.stringify(answer)}`);
    assert.deepEqual(got, { m: method, p: params, who: person, endpoint: "core" });
  }
});
test("media.generate and media.edit draw on the expensive bucket; the other Library methods do not", () => {
  for (const method of Object.keys(LIBRARY_MEDIA_CALLS)) assert.equal(EXPENSIVE_RPC_METHODS.has(method), method === "media.generate" || method === "media.edit", method);
});
test("principal spoofing is discarded; batches refused; errors have safe text with original code", async () => {
  let got: unknown;
  const core: CoreRpc = { call: async () => { throw new Error("legacy path"); }, callAs: async (m, p, who) => { got = { m, p, who }; return {} as never; } };
  const answer = await rpcRoute(core, { jsonrpc: "2.0", id: 1, method: "inbox.count", principal: { role: "owner" }, actAs: "bob", params: { principal: { role: "owner" }, actAs: "bob" } }, person);
  assert.ok("result" in answer); assert.deepEqual(got, { m: "inbox.count", p: {}, who: person });
  assert.ok("error" in await rpcRoute(core, [], person));
  core.callAs = async () => { throw { error: "E_DENIED", code: -32000, reason: "role-denied", message: "secret marker", detail: "secret marker", stack: "secret marker" }; };
  const denied = await rpcRoute(core, { jsonrpc: "2.0", id: 2, method: "inbox.count" }, person);
  assert.equal((denied.error as any).data.error, "E_DENIED"); assert.ok(!JSON.stringify(denied).includes("secret marker"));
});
test("fail-closed audience filtering accepts only self or this connection and audited global names", () => {
  const connectionId = "c";
  assert.equal(webEventAllowed("inbox.changed", person, { connectionId, audience: null }), false);
  assert.equal(webEventAllowed("inbox.changed", person, { connectionId, audience: [] }), false);
  assert.equal(webEventAllowed("inbox.changed", person, { connectionId, audience: [{ personId: "bob" }] }), false);
  assert.equal(webEventAllowed("inbox.changed", person, { connectionId, audience: [{ personId: "alice" }] }), true);
  assert.equal(webEventAllowed("inbox.changed", person, { connectionId, audience: [{ connectionId: "c" }] }), true);
  assert.equal(webEventAllowed("core.state", person, { connectionId, audience: null }), true);
  for (const malformed of [[null], [{ personId: "alice", connectionId: "c" }], [{ personId: "alice", unexpected: true }], "alice"])
    assert.equal(webEventAllowed("inbox.changed", person, { connectionId, audience: malformed as any }), false, "malformed or ambiguous audiences fail closed");
});
test("HTTP transport requires session, CSRF on reads too, and origin; size uses existing limit", async t => {
  const h = await start({ limits: { maxBodyBytes: 300 } }); t.after(() => h.close());
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "inbox.count" });
  const req = (headers: Record<string, string>, b = body) => raw(h, { method: "POST", path: "/rpc", headers: { "content-type": "application/json", ...headers }, body: b });
  assert.equal((await req({})).status, 401);
  const { cookie } = await login(h);
  assert.equal((await req({ cookie })).status, 403);
  assert.equal((await req({ cookie, origin: "https://hostile.invalid" })).status, 403);
  assert.equal((await req({ cookie, "x-csrf-token": await csrfToken(h, cookie) }, body + " ".repeat(400))).status, 413);
  const answer = await req({ cookie, "x-csrf-token": await csrfToken(h, cookie) });
  assert.equal(answer.status, 200); assert.equal(answer.json.error.data.error, "E_CORE_UNAVAILABLE");
});

test("bootstrap mapping cannot promote a directory user whose id is owner", () => {
  assert.equal(webPrincipal({ userId: "owner", kind: "person", role: "viewer" }).userId, "owner");
  assert.equal(webPrincipal({ userId: "owner", kind: "person", role: "owner" }, true).userId, "local-owner");
});

test("different cookie sessions of one person have distinct connection scopes; rotation drops the scope", () => {
  const sessions = new SessionStore(new FakeClock()); sessions.onEnd(forgetWebConnection);
  const first = sessions.create(OWNER), second = sessions.create(OWNER);
  const key = webConnection(first.session); assert.notEqual(key, webConnection(second.session));
  sessions.rotate(first.id); assert.notEqual(webConnection(first.session), key);
});

test("NC config mutations preflight through authenticated core and refuse before supervisor", async () => {
  const calls: string[]=[];
  const core = { callAs: async (method: string) => { calls.push(method); if(method==="model.licence.check") throw {error:"E_DENIED",reason:"model-licence-required"}; } } as unknown as CoreRpc;
  const r=await rpcRoute(core,{jsonrpc:"2.0",id:1,method:"config.set",params:{changes:[{key:"modelRoles.rerank",value:"jinaai/jina-reranker-v2-base-multilingual"}]}},person);
  assert.equal((r.error as any).data.error,"E_DENIED");assert.deepEqual(calls,["model.licence.check"]);
});

test('decision diagnostics have explicit web exposure and retain human settings guards', async () => {
  assert.equal(webEndpoint('decision.status'), 'core'); assert.equal(webEndpoint('decision.test'), 'core');
  let calls = 0;
  const core: CoreRpc = { call: async () => { throw Error('legacy'); }, callAs: async (method, params, principal) => {
    const methods = guardMethods({ [method]: async () => { calls++; return {}; } }, { resolve: () => principal as never, now: () => 0 });
    return await methods[method]!(params, { requestId: 'probe', connectionId: 'web', signal: AbortSignal.timeout(1000) }) as never;
  } };
  for (const principal of [{ userId: 'alice', kind: 'person', role: 'member' }, { userId: 'bot', kind: 'agent', agentId: 'a' }]) {
    const result = await rpcRoute(core, { jsonrpc: '2.0', id: 1, method: 'decision.test', params: { agentId: 'default' } }, principal as never);
    assert.ok('error' in result);
  }
  assert.equal(calls, 0);
});

test("engine role tests route explicit closed params and authenticated principal to core", async () => {
  const calls: unknown[] = [];
  const core: CoreRpc = { call: async () => { throw new Error("legacy"); }, callAs: async (method, params, principal) => { calls.push({ method, params, principal }); return { ok: true } as never; } };
  assert.equal(webEndpoint("admin.engine.test"), "core");
  const request = { jsonrpc: "2.0", id: 1, method: "admin.engine.test", params: { role: "embedder" } };
  const admin = { ...person, role: "admin" } as const;
  assert.ok("result" in await rpcRoute(core, request, admin));
  assert.deepEqual(calls, [{ method: "admin.engine.test", params: { role: "embedder" }, principal: admin }]);
  assert.ok("error" in await rpcRoute(core, { ...request, params: { role: "embedder", apiKey: "private" } }, admin));
  assert.ok("error" in await rpcRoute(core, request, { ...person, tokenScopes: ["chat:read"] } as any));
  assert.equal(calls.length, 1);
});
