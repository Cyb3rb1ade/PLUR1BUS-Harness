import { SessionStore, OWNER } from "../src/session.ts";
import { FakeClock } from "../src/clock.ts";
import { webPrincipal, webConnection, forgetWebConnection } from "../src/principal.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { rpcRoute, webEndpoint } from "../src/rpc-route.ts";
import { webEventAllowed } from "../src/events-route.ts";
import { start, raw, login, csrfToken } from "./helpers.ts";
import type { CoreRpc } from "../src/core-rpc.ts";
const person = { userId: "alice", kind: "person", role: "member" } as const;

test("explicit web exposure rejects internal and unrelated supervisor methods", () => {
  for (const m of ["core.auth", "core.adopt", "core.shutdown", "supervisor.auth", "daemon.stop", "config.watch", "module.watch", "events.subscribe", "admin.backup.snapshot", "secret.get", "memory.capture", "api.unknown"]) assert.equal(webEndpoint(m), null, m);
  assert.equal(webEndpoint("inbox.list"), "core"); assert.equal(webEndpoint("config.set"), "supervisor");
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
