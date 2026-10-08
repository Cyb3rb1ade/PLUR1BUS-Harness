import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BodyTooLarge, createA2aHandler, type A2aHandler, type A2aHttpRequest, type A2aHttpResponse } from "../../src/a2a/handler.ts";
import { hashKey } from "../../src/a2a/policy.ts";
import { PushDispatcher, type PushTransport } from "../../src/a2a/push.ts";
import { TaskError } from "../../src/a2a/tasks.ts";
import type { A2aTurnPort } from "../../src/a2a/turn-port.ts";
import type { A2aPeerConfig } from "../../src/a2a/types.ts";
import type { Egress } from "../../src/egress/service.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { AGENTS, allowPush, BASE, collectSse, http, KEY_A, KEY_B, ManualScheduler, peers, rig, rpc, rpcStream, sendMsg, TestClock } from "./helpers.ts";

const never = (): Promise<void> => new Promise(() => {});
const JSON_CT = { "content-type": "application/json" };
const rawPost = (h: A2aHandler, body: string | Buffer, headers: Record<string, string> = JSON_CT, path = "/a2a/bernd/") =>
  http(h, { path, raw: Buffer.isBuffer(body) ? body : Buffer.from(body), headers });
const parse = (r: A2aHttpResponse): any => JSON.parse(r.body);
const env = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const KEY_C = "peer-c-key-0123456789abcdef0123456789abcdef";
const peerC = (grants: A2aPeerConfig["grants"]): A2aPeerConfig => ({ id: "peer-c", keySha256: hashKey(KEY_C), grants });
const withC = (grants: A2aPeerConfig["grants"]): A2aPeerConfig[] => [...peers(), peerC(grants)];
const auditActions = (r: { audit: { events: { action: string }[] } }): string[] => r.audit.events.map((e) => e.action);

describe("BodyTooLarge", () => {
  it("is a named Error", () => {
    const e = new BodyTooLarge();
    assert.ok(e instanceof Error); assert.equal(e.name, "BodyTooLarge"); assert.equal(e.message, "body too large");
  });
});

describe("handler construction", () => {
  it("rejects a malformed peer table at start", () => {
    assert.throws(() => createA2aHandler({ peers: [{ id: "bad id", keySha256: "x", grants: {} }], agents: () => undefined, advertisedBaseUrl: BASE, provider: () => null }), /invalid/);
  });
  it("merges partial limits over the defaults and exposes tasks", () => {
    const { h } = rig({ opts: { limits: { maxParts: 2 } } });
    assert.equal(h.limits.maxParts, 2); assert.equal(h.limits.maxBodyBytes, 1024 * 1024);
    assert.equal(h.tasks.size, 0);
  });
  it("works with only the required options (real clock, real scheduler, no audit)", async () => {
    const h = createA2aHandler({ peers: peers(), agents: (id) => AGENTS[id], advertisedBaseUrl: BASE, provider: () => new FakeChatProvider() });
    const r = await rpc(h, "message/send", sendMsg("hi", {}, { blocking: true }));
    assert.equal(r.json.result.status.state, "completed");
    const bad = await http(h, { path: "/a2a/bernd/", key: "wrong", body: env("tasks/get") });
    assert.equal(bad.status, 401);
  });
  it("a throwing audit sink never changes the answer", async () => {
    const r = rig({ opts: { audit: { append: () => { throw new Error("disk full"); } } } });
    assert.equal((await http(r.h, { path: "/a2a/bernd/", key: "wrong", body: env("tasks/get") })).status, 401);
  });
  it("the version option reaches the card; default is 0.1.0", async () => {
    const a = rig({ opts: { version: "9.9.9" } }); const b = rig();
    assert.equal(parse(await http(a.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json" })).version, "9.9.9");
    assert.equal(parse(await http(b.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json" })).version, "0.1.0");
  });
});

describe("routing", () => {
  const cardPath = "/a2a/bernd/.well-known/agent-card.json";
  it("serves the card with security headers", async () => {
    const { h } = rig();
    const r = await http(h, { method: "GET", path: cardPath });
    assert.equal(r.status, 200);
    assert.equal(r.headers["Cache-Control"], "no-store"); assert.equal(r.headers["X-Content-Type-Options"], "nosniff");
    assert.match(r.headers["Content-Type"]!, /^application\/json/);
    assert.equal(parse(r).name, "Bernd");
  });
  it("a card for an agent without displayName falls back to the id", async () => {
    const { h } = rig({ opts: { peers: withC({ anna: ["card.read"] }) } });
    const r = await http(h, { method: "GET", path: "/a2a/anna/.well-known/agent-card.json", key: KEY_C });
    assert.equal(parse(r).name, "anna");
  });
  it("the features option turns card capabilities off", async () => {
    const { h } = rig({ opts: { features: { streaming: false } } });
    const c = parse(await http(h, { method: "GET", path: cardPath }));
    assert.deepEqual(c.capabilities, { streaming: false, pushNotifications: true, stateTransitionHistory: false });
  });
  describe("origin card path", () => {
    it("is 404 without defaultAgentId", async () => {
      const { h } = rig();
      assert.equal((await http(h, { method: "GET", path: "/.well-known/agent-card.json" })).status, 404);
    });
    for (const bad of ["bad id", "a/b", "x".repeat(65), ""]) {
      it(`is 404 for an invalid defaultAgentId ${JSON.stringify(bad.slice(0, 10))}`, async () => {
        const { h } = rig({ opts: { defaultAgentId: bad } });
        assert.equal((await http(h, { method: "GET", path: "/.well-known/agent-card.json" })).status, 404);
      });
    }
    it("serves the default agent's card (auth still required)", async () => {
      const { h } = rig({ opts: { defaultAgentId: "bernd" } });
      assert.equal((await http(h, { method: "GET", path: "/.well-known/agent-card.json", key: null })).status, 401);
      const r = await http(h, { method: "GET", path: "/.well-known/agent-card.json" });
      assert.equal(r.status, 200); assert.equal(parse(r).url, `${BASE}/a2a/bernd/`);
    });
    it("POST to the origin card path is 405 with Allow GET", async () => {
      const { h } = rig({ opts: { defaultAgentId: "bernd" } });
      const r = await http(h, { method: "POST", path: "/.well-known/agent-card.json", body: {} });
      assert.equal(r.status, 405); assert.equal(r.headers.Allow, "GET");
    });
  });
  const notFound = ["/", "/a2a", "/a2a/", "/a2a//", "/a2a/bernd", "/a2a/bernd/x", "/a2a/bernd/.well-known/other.json", "/b2b/bernd/", "/a2a/ber nd/", `/a2a/${"x".repeat(65)}/`, "/a2a/b%20d/", "/a2a/../x/", "/a2a/bernd/.well-known/agent-card.json/"];
  for (const p of notFound) {
    it(`404 for ${JSON.stringify(p)}`, async () => {
      const { h } = rig();
      const r = await http(h, { method: "GET", path: p });
      assert.equal(r.status, 404); assert.deepEqual(parse(r), { error: "not-found" });
    });
  }
  for (const m of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "get", ""]) {
    it(`card endpoint rejects method ${JSON.stringify(m)} with 405 Allow GET`, async () => {
      const { h } = rig();
      const r = await http(h, { method: m, path: cardPath, body: m === "POST" ? {} : undefined });
      assert.equal(r.status, 405); assert.equal(r.headers.Allow, "GET");
    });
  }
  for (const m of ["GET", "PUT", "DELETE", "OPTIONS", "post"]) {
    it(`rpc endpoint rejects method ${JSON.stringify(m)} with 405 Allow POST`, async () => {
      const { h } = rig();
      const r = await http(h, { method: m, path: "/a2a/bernd/" });
      assert.equal(r.status, 405); assert.equal(r.headers.Allow, "POST");
    });
  }
  it("an unknown agent id is 404 for an authenticated peer, for card and rpc alike", async () => {
    const { h } = rig();
    assert.equal((await http(h, { method: "GET", path: "/a2a/nobody/.well-known/agent-card.json" })).status, 404);
    assert.equal((await http(h, { path: "/a2a/nobody/", body: env("tasks/get", { id: "x" }), headers: JSON_CT })).status, 404);
    assert.equal((await http(h, { path: "/a2a/hidden/", body: env("tasks/get", { id: "x" }) })).status, 404);
  });
});

describe("rate limits and authentication", () => {
  it("the address bucket answers 429 with Retry-After and is audited", async () => {
    const r = rig({ opts: { limits: { addressRatePerMinute: 2 } } });
    assert.equal((await http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json" })).status, 200);
    assert.equal((await http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json" })).status, 200);
    const limited = await http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json" });
    assert.equal(limited.status, 429); assert.equal(limited.headers["Retry-After"], "30");
    assert.ok(r.audit.events.some((e) => e.action === "a2a.rate-limited" && (e.detail as any).scope === "address"));
  });
  it("buckets refill over time and are per address", async () => {
    const r = rig({ opts: { limits: { addressRatePerMinute: 1 } } });
    const card = (remote: string) => http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json", remote });
    assert.equal((await card("1.1.1.1")).status, 200);
    assert.equal((await card("1.1.1.1")).status, 429);
    assert.equal((await card("2.2.2.2")).status, 200);
    r.clock.advance(60_000);
    assert.equal((await card("1.1.1.1")).status, 200);
  });
  it("repeated bad credentials lock the address out (429, Retry-After 60), even for a valid key", async () => {
    const r = rig({ opts: { limits: { failedAuthPerMinute: 2 } } });
    for (let i = 0; i < 2; i++) assert.equal((await http(r.h, { path: "/a2a/bernd/", key: "nope", body: env("tasks/get") })).status, 401);
    const locked = await http(r.h, { path: "/a2a/bernd/", body: env("tasks/get", { id: "x" }) });
    assert.equal(locked.status, 429); assert.equal(locked.headers["Retry-After"], "60");
    assert.ok(r.audit.events.some((e) => e.action === "a2a.rate-limited" && (e.detail as any).scope === "failed-auth"));
    // other addresses are unaffected
    assert.equal((await http(r.h, { path: "/a2a/bernd/", body: env("tasks/get", { id: "x" }), remote: "9.9.9.9" })).status, 200);
  });
  const badAuth: [string, string | undefined, string][] = [
    ["no header", undefined, "no-credential"],
    ["wrong scheme", "Basic abc", "no-credential"],
    ["lower-case scheme", "bearer abc", "no-credential"],
    ["empty token", "Bearer ", "no-credential"],
    ["token with space", "Bearer a b", "no-credential"],
    ["token with non-ascii", "Bearer tök", "no-credential"],
    ["token over 512 chars", `Bearer ${"a".repeat(513)}`, "no-credential"],
    ["unknown token", "Bearer unknown-key", "bad-credential"],
    ["token of exactly 512 chars", `Bearer ${"a".repeat(512)}`, "bad-credential"],
  ];
  for (const [label, header, reason] of badAuth) {
    it(`401 for ${label} (audit reason ${reason})`, async () => {
      const r = rig();
      const res = await http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json", key: null, headers: header === undefined ? {} : { authorization: header } });
      assert.equal(res.status, 401); assert.equal(res.headers["WWW-Authenticate"], "Bearer");
      assert.deepEqual(parse(res), { error: "unauthenticated" });
      const ev = r.audit.events.find((e) => e.action === "a2a.unauthenticated")!;
      assert.equal((ev.detail as any).reason, reason);
      assert.equal(ev.actor.user, "anonymous");
    });
  }
  it("the peer bucket limits an authenticated peer by id and is audited with its principal", async () => {
    const r = rig({ opts: { limits: { peerRatePerMinute: 2 } } });
    for (let i = 0; i < 2; i++) assert.equal((await rpc(r.h, "tasks/get", { id: "x" })).status, 200);
    const limited = await http(r.h, { path: "/a2a/bernd/", body: env("tasks/get", { id: "x" }) });
    assert.equal(limited.status, 429); assert.equal(limited.headers["Retry-After"], "30");
    const ev = r.audit.events.find((e) => e.action === "a2a.rate-limited" && (e.detail as any).scope === "peer")!;
    assert.equal(ev.actor.user, "a2a-peer:peer-a");
    // another peer is not affected
    assert.equal((await rpc(r.h, "tasks/get", { id: "x" }, { key: KEY_B })).status, 200);
  });
  describe("verifyBearer", () => {
    it("replaces the key table; sync and async results are accepted; undefined is 401", async () => {
      const sync = rig({ opts: { verifyBearer: (t) => (t === "tok" ? { kind: "a2a-peer", peerId: "peer-a" } : undefined) } });
      assert.equal((await rpc(sync.h, "tasks/get", { id: "x" }, { key: "tok" })).status, 200);
      assert.equal((await http(sync.h, { path: "/a2a/bernd/", key: KEY_A, body: env("tasks/get") })).status, 401);
      const asyncRig = rig({ opts: { verifyBearer: async (t) => (t === "tok" ? { kind: "a2a-peer", peerId: "peer-b" } : undefined) } });
      assert.equal((await rpc(asyncRig.h, "tasks/get", { id: "x" }, { key: "tok" })).status, 200);
      assert.equal((await http(asyncRig.h, { path: "/a2a/bernd/", key: "other", body: env("tasks/get") })).status, 401);
    });
    it("a verified peer that has no entry in the peer table is denied, not crashed", { skip: "BUG: o.peers.find(...)!.grants wirft TypeError fuer verifizierten Peer ohne Tabelleneintrag - siehe docs/testing/coverage-2026-10.md#a2a-handler-verifybearer-unknown-peer" }, async () => {
      const r = rig({ opts: { verifyBearer: () => ({ kind: "a2a-peer", peerId: "ghost" }) } });
      const res = await http(r.h, { path: "/a2a/bernd/", body: env("tasks/get", { id: "x" }) });
      assert.equal(res.status, 404);
    });
    it("a verified peer without table entry gets 404 on the card path", async () => {
      const r = rig({ opts: { verifyBearer: () => ({ kind: "a2a-peer", peerId: "ghost" }) } });
      assert.equal((await http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json" })).status, 404);
    });
  });
});

describe("authorisation", () => {
  it("card: unknown agent, opted-out agent and ungranted agent are 404 (audited), a missing action is 403", async () => {
    const r = rig({ opts: { peers: withC({ bernd: [], anna: ["card.read"] }) } });
    const card = (agent: string, key = KEY_C) => http(r.h, { method: "GET", path: `/a2a/${agent}/.well-known/agent-card.json`, key });
    assert.equal((await card("nobody")).status, 404);
    assert.equal((await card("hidden")).status, 404);
    assert.equal((await card("anna", KEY_B)).status, 200);
    assert.equal((await card("anna")).status, 200);
    const forbidden = await card("bernd");
    assert.equal(forbidden.status, 403); assert.deepEqual(parse(forbidden), { error: "forbidden" });
    const reasons = r.audit.events.filter((e) => e.action === "a2a.denied").map((e) => (e.detail as any).reason);
    assert.deepEqual(reasons, ["unknown-agent", "agent-not-exposed", "action-not-granted"]);
  });
  it("card: a peer without any grant for the agent is 404", async () => {
    const r = rig({ opts: { peers: withC({ anna: ["card.read"] }) } });
    const res = await http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json", key: KEY_C });
    assert.equal(res.status, 404);
    assert.equal((r.audit.events.at(-1)!.detail as any).reason, "peer-not-granted-agent");
  });
  it("rpc: the early agent check distinguishes unknown, not exposed and not granted in the audit", async () => {
    const r = rig({ opts: { peers: withC({ anna: ["task.send"] }) } });
    const go = (agent: string) => http(r.h, { path: `/a2a/${agent}/`, key: KEY_C, body: env("tasks/get", { id: "x" }) });
    for (const a of ["nobody", "hidden", "bernd"]) assert.equal((await go(a)).status, 404);
    const reasons = r.audit.events.filter((e) => e.action === "a2a.denied").map((e) => (e.detail as any).reason);
    assert.deepEqual(reasons, ["unknown-agent", "agent-not-exposed", "peer-not-granted-agent"]);
    assert.ok(r.audit.events.filter((e) => e.action === "a2a.denied").every((e) => (e.detail as any).action === "rpc"));
  });
  const methods: [string, unknown][] = [
    ["message/send", sendMsg("x")], ["message/stream", sendMsg("x")], ["tasks/get", { id: "x" }], ["tasks/cancel", { id: "x" }],
    ["tasks/resubscribe", { id: "x" }], ["tasks/pushNotificationConfig/set", { id: "x", pushNotificationConfig: { url: "http://h/" } }],
    ["tasks/pushNotificationConfig/get", { id: "x" }], ["tasks/pushNotificationConfig/list", { id: "x" }], ["tasks/pushNotificationConfig/delete", { id: "x", pushNotificationConfigId: "c" }],
  ];
  for (const [method, params] of methods) {
    it(`${method} without its action grant is a JSON-RPC forbidden error`, async () => {
      const r = rig({ opts: { peers: withC({ bernd: ["card.read"] }), pushTransport: allowPush } });
      const res = await rpc(r.h, method, params, { key: KEY_C });
      assert.equal(res.status, 200);
      assert.equal(res.json.error.code, -32600); assert.equal(res.json.error.message, "not permitted"); assert.equal(res.json.error.data.reason, "forbidden");
      assert.equal(r.h.tasks.size, 0);
    });
  }
});

describe("request envelope", () => {
  const cases: [string, string, number, string | undefined][] = [
    ["invalid JSON", "{nope", -32700, undefined],
    ["empty body", "", -32700, undefined],
    ["truncated JSON", '{"jsonrpc":"2.0"', -32700, undefined],
    ["batch", "[]", -32600, "batch"],
    ["non-empty batch", JSON.stringify([env("tasks/get")]), -32600, "batch"],
    ["number", "5", -32600, undefined],
    ["null", "null", -32600, undefined],
    ["string", '"x"', -32600, undefined],
    ["wrong version", JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tasks/get" }), -32600, undefined],
    ["no version", JSON.stringify({ id: 1, method: "tasks/get" }), -32600, undefined],
    ["method not a string", JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 }), -32600, undefined],
    ["no method", JSON.stringify({ jsonrpc: "2.0", id: 1 }), -32600, undefined],
    ["no id (notification)", JSON.stringify({ jsonrpc: "2.0", method: "tasks/get" }), -32600, undefined],
    ["null id", JSON.stringify({ jsonrpc: "2.0", id: null, method: "tasks/get" }), -32600, undefined],
    ["boolean id", JSON.stringify({ jsonrpc: "2.0", id: true, method: "tasks/get" }), -32600, undefined],
    ["object id", JSON.stringify({ jsonrpc: "2.0", id: {}, method: "tasks/get" }), -32600, undefined],
    ["unknown method", JSON.stringify(env("tasks/nope")), -32601, undefined],
    ["inherited method name", JSON.stringify(env("constructor")), -32601, undefined],
    ["__proto__ method", JSON.stringify(env("__proto__")), -32601, undefined],
    ["toString method", JSON.stringify(env("toString")), -32601, undefined],
    ["method case differs", JSON.stringify(env("Message/Send")), -32601, undefined],
    ["unknown push sub-method", JSON.stringify(env("tasks/pushNotificationConfig/nope")), -32601, undefined],
  ];
  for (const [label, body, code, reason] of cases) {
    it(`${label} -> ${code}${reason ? ` (${reason})` : ""}`, async () => {
      const { h } = rig();
      const r = await rawPost(h, body);
      assert.equal(r.status, 200);
      const j = parse(r);
      assert.equal(j.jsonrpc, "2.0"); assert.equal(j.error.code, code); assert.equal(j.error.data?.reason, reason);
    });
  }
  it("the error echoes a string or numeric id, null otherwise", async () => {
    const { h } = rig();
    assert.equal(parse(await rawPost(h, JSON.stringify(env("tasks/nope", undefined, "abc")))).id, "abc");
    assert.equal(parse(await rawPost(h, JSON.stringify(env("tasks/nope", undefined, 0)))).id, 0);
    assert.equal(parse(await rawPost(h, "{")).id, null);
  });
  it("BOM-less UTF-8 with non-ASCII ids round-trips", async () => {
    const { h } = rig();
    assert.equal(parse(await rawPost(h, JSON.stringify(env("tasks/nope", undefined, "ü🌍")))).id, "ü🌍");
  });
  const ct: [string | undefined, number][] = [
    [undefined, 415], ["", 415], ["text/plain", 415], ["application/xml", 415], ["application/jsonx", 415],
    ["application/json", 200], ["Application/JSON", 200], ["application/json; charset=utf-8", 200], [" application/json ;x=1", 200],
  ];
  for (const [value, status] of ct) {
    it(`content-type ${JSON.stringify(value)} -> ${status}`, async () => {
      const { h } = rig();
      const r = await http(h, { path: "/a2a/bernd/", raw: Buffer.from(JSON.stringify(env("tasks/nope"))), headers: value === undefined ? {} : { "content-type": value } });
      assert.equal(r.status, status);
      if (status === 415) assert.deepEqual(parse(r), { error: "unsupported-media-type" });
    });
  }
  const lengths: [string, number][] = [["abc", 413], ["-5", 413], ["1.5", 413], ["", 413], ["1000000000", 413], ["2", 200], ["0", 200]];
  for (const [value, status] of lengths) {
    it(`content-length ${JSON.stringify(value)} -> ${status}`, async () => {
      const r = rig({ opts: { limits: { maxBodyBytes: 4096 } } });
      const res = await rawPost(r.h, JSON.stringify(env("tasks/nope")), { ...JSON_CT, "content-length": value });
      assert.equal(res.status, status);
      if (status === 413) { assert.equal(res.headers.Connection, "close"); assert.ok(auditActions(r).includes("a2a.too-large")); }
    });
  }
  it("a declared length exactly at the cap is accepted", async () => {
    const r = rig({ opts: { limits: { maxBodyBytes: 4096 } } });
    assert.equal((await rawPost(r.h, JSON.stringify(env("tasks/nope")), { ...JSON_CT, "content-length": "4096" })).status, 200);
    assert.equal((await rawPost(r.h, JSON.stringify(env("tasks/nope")), { ...JSON_CT, "content-length": "4097" })).status, 413);
  });
  it("readBody failures: BodyTooLarge -> 413, other errors -> 400, oversize buffer -> 413", async () => {
    const r = rig({ opts: { limits: { maxBodyBytes: 64 } } });
    const base: A2aHttpRequest = { method: "POST", path: "/a2a/bernd/", headers: { authorization: `Bearer ${KEY_A}`, ...JSON_CT }, remote: "1.2.3.4", readBody: async () => Buffer.alloc(0) };
    const tooLarge = await r.h.handle({ ...base, readBody: async () => { throw new BodyTooLarge(); } });
    assert.equal(tooLarge.status, 413); assert.equal(tooLarge.headers.Connection, "close");
    const unreadable = await r.h.handle({ ...base, readBody: async () => { throw new Error("socket reset"); } });
    assert.equal(unreadable.status, 400); assert.deepEqual(parse(unreadable), { error: "unreadable-body" });
    const oversize = await r.h.handle({ ...base, readBody: async () => Buffer.alloc(65, 0x20) });
    assert.equal(oversize.status, 413);
  });
  it("the limit passed to readBody is maxBodyBytes", async () => {
    const r = rig({ opts: { limits: { maxBodyBytes: 777 } } });
    let seen = 0;
    await r.h.handle({ method: "POST", path: "/a2a/bernd/", headers: { authorization: `Bearer ${KEY_A}`, ...JSON_CT }, remote: "r", readBody: async (l) => { seen = l; return Buffer.from("{"); } });
    assert.equal(seen, 777);
  });
  it("body is never read for a route, auth or authorisation failure", async () => {
    const r = rig();
    let read = 0;
    const mk = (over: Partial<A2aHttpRequest>): A2aHttpRequest => ({ method: "POST", path: "/a2a/bernd/", headers: { authorization: `Bearer ${KEY_A}`, ...JSON_CT }, remote: "r", readBody: async () => { read++; return Buffer.from("{}"); }, ...over });
    await r.h.handle(mk({ path: "/x" })); await r.h.handle(mk({ headers: {} })); await r.h.handle(mk({ path: "/a2a/nobody/" })); await r.h.handle(mk({ headers: { authorization: `Bearer ${KEY_A}` } }));
    assert.equal(read, 0);
  });
});

describe("feature switches", () => {
  for (const method of ["message/stream", "tasks/resubscribe"]) {
    it(`${method} with streaming off is UnsupportedOperation (not-implemented)`, async () => {
      const { h } = rig({ opts: { features: { streaming: false } } });
      const r = await rpc(h, method, method === "message/stream" ? sendMsg("x") : { id: "x" });
      assert.equal(r.json.error.code, -32004); assert.equal(r.json.error.data.reason, "not-implemented");
    });
  }
  for (const method of ["set", "get", "list", "delete"]) {
    it(`pushNotificationConfig/${method} with push off is PushNotificationNotSupported`, async () => {
      const { h } = rig({ opts: { features: { pushNotifications: false } } });
      const r = await rpc(h, `tasks/pushNotificationConfig/${method}`, { id: "x" });
      assert.equal(r.json.error.code, -32003);
    });
  }
  it("message/send with a pushNotificationConfig while push is off is -32003 and starts no task", async () => {
    const { h } = rig({ opts: { features: { pushNotifications: false } } });
    const r = await rpc(h, "message/send", sendMsg("x", {}, { pushNotificationConfig: { url: "http://h/" } }));
    assert.equal(r.json.error.code, -32003); assert.equal(h.tasks.size, 0);
  });
  it("message/send/get/cancel still work with streaming and push off", async () => {
    const { h } = rig({ opts: { features: { streaming: false, pushNotifications: false } } });
    const t = (await rpc(h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    assert.equal(t.status.state, "completed");
    assert.equal((await rpc(h, "tasks/get", { id: t.id })).json.result.id, t.id);
  });
});

describe("message/send validation", () => {
  const validMsg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ role: "user", messageId: "m1", parts: [{ kind: "text", text: "hi" }], ...over });
  const bad: [string, unknown, string][] = [
    ["params undefined", undefined, "params.message is required"],
    ["params null", null, "params.message is required"],
    ["params array", [], "params.message is required"],
    ["params string", "x", "params.message is required"],
    ["message missing", {}, "params.message is required"],
    ["message array", { message: [] }, "params.message is required"],
    ["message string", { message: "hi" }, "params.message is required"],
    ["role agent", { message: validMsg({ role: "agent" }) }, "message.role must be user"],
    ["role missing", { message: validMsg({ role: undefined }) }, "message.role must be user"],
    ["messageId missing", { message: validMsg({ messageId: undefined }) }, "message.messageId is required"],
    ["messageId empty", { message: validMsg({ messageId: "" }) }, "message.messageId is required"],
    ["messageId number", { message: validMsg({ messageId: 5 }) }, "message.messageId is required"],
    ["messageId 129 chars", { message: validMsg({ messageId: "a".repeat(129) }) }, "message.messageId is required"],
    ["messageId newline", { message: validMsg({ messageId: "a\nb" }) }, "message.messageId is required"],
    ["messageId NUL", { message: validMsg({ messageId: "a\u0000b" }) }, "message.messageId is required"],
    ["messageId DEL", { message: validMsg({ messageId: "a\u007fb" }) }, "message.messageId is required"],
    ["taskId number", { message: validMsg({ taskId: 5 }) }, "message.taskId is invalid"],
    ["taskId empty", { message: validMsg({ taskId: "" }) }, "message.taskId is invalid"],
    ["taskId null", { message: validMsg({ taskId: null }) }, "message.taskId is invalid"],
    ["taskId control", { message: validMsg({ taskId: "a\tb" }) }, "message.taskId is invalid"],
    ["contextId number", { message: validMsg({ contextId: 5 }) }, "message.contextId is invalid"],
    ["contextId too long", { message: validMsg({ contextId: "c".repeat(129) }) }, "message.contextId is invalid"],
    ["parts missing", { message: validMsg({ parts: undefined }) }, "message.parts must be a non-empty array"],
    ["parts empty", { message: validMsg({ parts: [] }) }, "message.parts must be a non-empty array"],
    ["parts object", { message: validMsg({ parts: {} }) }, "message.parts must be a non-empty array"],
    ["part null", { message: validMsg({ parts: [null] }) }, "invalid part"],
    ["part without kind", { message: validMsg({ parts: [{ text: "x" }] }) }, "invalid part"],
    ["text part without text", { message: validMsg({ parts: [{ kind: "text" }] }) }, "text part needs a text string"],
    ["file part without file", { message: validMsg({ parts: [{ kind: "file" }] }) }, "file part needs a file object"],
    ["file without bytes or uri", { message: validMsg({ parts: [{ kind: "file", file: { name: "n" } }] }) }, "file part needs bytes or a uri"],
    ["data part without data", { message: validMsg({ parts: [{ kind: "data", data: [] }] }) }, "data part needs a data object"],
    ["whitespace-only text", { message: validMsg({ parts: [{ kind: "text", text: " \n\t" }] }) }, "message text is empty"],
  ];
  for (const [label, params, message] of bad) {
    it(`invalid params: ${label}`, async () => {
      const { h } = rig();
      const r = await rpc(h, "message/send", params);
      assert.equal(r.json.error.code, -32602); assert.equal(r.json.error.message, message);
      assert.equal(h.tasks.size, 0);
    });
  }
  it("an unsupported part kind is ContentTypeNotSupported", async () => {
    const { h } = rig();
    const r = await rpc(h, "message/send", { message: validMsg({ parts: [{ kind: "video", url: "x" }] }) });
    assert.equal(r.json.error.code, -32005);
  });
  const limitCases: [string, Record<string, number>, unknown, string][] = [
    ["text", { maxTextBytes: 10 }, [{ kind: "text", text: "x".repeat(11) }], "text-too-large"],
    ["file", { maxFileBytes: 8 }, [{ kind: "file", file: { bytes: "A".repeat(100) } }], "file-too-large"],
    ["data", { maxDataBytes: 8 }, [{ kind: "data", data: { k: "long value here" } }], "data-too-large"],
    ["parts", { maxParts: 1 }, [{ kind: "text", text: "a" }, { kind: "text", text: "b" }], "too-many-parts"],
  ];
  for (const [label, limits, parts, reason] of limitCases) {
    it(`${label} over its limit -> -32602 ${reason}`, async () => {
      const { h } = rig({ opts: { limits } });
      const r = await rpc(h, "message/send", { message: validMsg({ parts }) });
      assert.equal(r.json.error.code, -32602); assert.equal(r.json.error.data.reason, reason);
    });
  }
  it("a file part by uri or bytes and a data part are accepted", async () => {
    const { h } = rig();
    const r = await rpc(h, "message/send", { message: validMsg({ parts: [
      { kind: "file", file: { uri: "https://example.test/a.png", name: "a.png" } },
      { kind: "file", file: { bytes: "aGVsbG8=", mimeType: "text/plain" } },
      { kind: "data", data: { a: 1 } },
    ] }), configuration: { blocking: true } });
    assert.equal(r.json.result.status.state, "completed");
    assert.equal(r.json.result.history[0].parts.length, 3);
  });
  it("a non-object configuration is ignored (non-blocking)", async () => {
    const { h } = rig();
    for (const configuration of ["x", 5, null, []]) {
      const r = await rpc(h, "message/send", { message: validMsg({ messageId: `m-${JSON.stringify(configuration)}` }), configuration });
      assert.equal(r.json.result.status.state, "working");
    }
  });
  it("blocking is only true for boolean true", async () => {
    const { h } = rig();
    for (const [i, blocking] of ([false, "true", 1, null] as unknown[]).entries()) {
      const r = await rpc(h, "message/send", { message: validMsg({ messageId: `b-${i}` }), configuration: { blocking } });
      assert.equal(r.json.result.status.state, "working", String(blocking));
    }
    const ok = await rpc(h, "message/send", { message: validMsg({ messageId: "b-ok" }), configuration: { blocking: true } });
    assert.equal(ok.json.result.status.state, "completed");
  });
  it("blocking waits for pauses too (input-required)", async () => {
    const { h } = rig();
    const r = await rpc(h, "message/send", sendMsg("INPUT_REQUIRED please", {}, { blocking: true }));
    assert.equal(r.json.result.status.state, "input-required");
  });
  it("a context id and a follow-up task id flow through", async () => {
    const { h } = rig();
    const first = (await rpc(h, "message/send", sendMsg("INPUT_REQUIRED", { contextId: "ctx-1" }, { blocking: true }))).json.result;
    assert.equal(first.contextId, "ctx-1");
    const second = (await rpc(h, "message/send", sendMsg("more", { taskId: first.id }, { blocking: true }))).json.result;
    assert.equal(second.id, first.id); assert.equal(second.status.state, "completed");
  });
  it("a follow-up to an unknown task is TaskNotFound", async () => {
    const { h } = rig();
    assert.equal((await rpc(h, "message/send", sendMsg("x", { taskId: "ghost" }))).json.error.code, -32001);
  });
  it("a follow-up to a finished task is UnsupportedOperation", async () => {
    const { h } = rig();
    const t = (await rpc(h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    assert.equal((await rpc(h, "message/send", sendMsg("y", { taskId: t.id }))).json.error.code, -32004);
  });
});

describe("error mapping", () => {
  const portThrowing = (err: unknown): A2aTurnPort => ({
    available: () => true, ensureSession: () => { throw err; }, run: async function* () {}, cancel: () => false,
  });
  const cases: [string, unknown, number, string | undefined][] = [
    ["TaskError not-found", new TaskError("not-found", "x"), -32001, undefined],
    ["TaskError not-cancelable", new TaskError("not-cancelable", "x"), -32002, undefined],
    ["TaskError too-many", new TaskError("too-many", "x"), -32000, "task-limit"],
    ["TaskError no-provider", new TaskError("no-provider", "x"), -32603, "no-provider"],
    ["TaskError unsupported", new TaskError("unsupported", "x"), -32004, undefined],
    ["TaskError invalid", new TaskError("invalid", "x"), -32602, undefined],
    ["unexpected Error", new Error("db exploded: secret"), -32603, undefined],
    ["non-Error throw", "boom", -32603, undefined],
  ];
  for (const [label, err, code, reason] of cases) {
    it(`${label} -> ${code}`, async () => {
      const { h } = rig({ opts: { turns: portThrowing(err) } });
      const r = await rpc(h, "message/send", sendMsg("x"));
      assert.equal(r.json.error.code, code); assert.equal(r.json.error.data?.reason, reason);
      assert.ok(!JSON.stringify(r.json).includes("secret"));
    });
  }
  it("an unavailable provider is the no-provider error and stores nothing", async () => {
    const { h } = rig({ provider: null });
    const r = await rpc(h, "message/send", sendMsg("x"));
    assert.equal(r.json.error.code, -32603); assert.equal(r.json.error.data.reason, "no-provider"); assert.equal(h.tasks.size, 0);
  });
  it("too many live tasks per peer is the limit error", async () => {
    const { h } = rig({ fake: { gate: never }, opts: { limits: { maxLiveTasksPerPeer: 1 } } });
    assert.equal((await rpc(h, "message/send", sendMsg("a"))).json.result.status.state, "working");
    const r = await rpc(h, "message/send", sendMsg("b"));
    assert.equal(r.json.error.code, -32000); assert.equal(r.json.error.data.reason, "task-limit");
  });
});

describe("tasks/get and tasks/cancel", () => {
  for (const [label, params] of [["undefined", undefined], ["null", null], ["array", []], ["no id", {}], ["empty id", { id: "" }], ["numeric id", { id: 5 }], ["long id", { id: "a".repeat(129) }], ["control id", { id: "a\nb" }]] as [string, unknown][]) {
    for (const method of ["tasks/get", "tasks/cancel", "tasks/resubscribe"]) {
      it(`${method} with ${label} params -> params.id is required`, async () => {
        const { h } = rig();
        const r = await rpc(h, method, params);
        assert.equal(r.json.error.code, -32602); assert.equal(r.json.error.message, "params.id is required");
      });
    }
  }
  for (const [label, value] of [["negative", -1], ["fraction", 1.5], ["string", "2"], ["null", null], ["boolean", true], ["NaN-ish", "NaN"]] as [string, unknown][]) {
    it(`historyLength ${label} is invalid`, async () => {
      const { h } = rig();
      const r = await rpc(h, "tasks/get", { id: "x", historyLength: value });
      assert.equal(r.json.error.code, -32602); assert.match(r.json.error.message, /historyLength/);
    });
  }
  it("historyLength 0, 1 and large values are accepted; the maximum is the configured history", async () => {
    const { h } = rig({ opts: { limits: { maxHistoryLength: 1 } } });
    const t = (await rpc(h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    assert.equal((await rpc(h, "tasks/get", { id: t.id, historyLength: 0 })).json.result.history, undefined);
    assert.equal((await rpc(h, "tasks/get", { id: t.id, historyLength: 1 })).json.result.history.length, 1);
    assert.equal((await rpc(h, "tasks/get", { id: t.id, historyLength: 1_000_000 })).json.result.history.length, 1);
    assert.equal((await rpc(h, "tasks/get", { id: t.id })).json.result.history.length, 1);
  });
  it("unknown ids are TaskNotFound for get and cancel; a peer cannot see another peer's task", async () => {
    const { h } = rig();
    assert.equal((await rpc(h, "tasks/get", { id: "nope" })).json.error.code, -32001);
    assert.equal((await rpc(h, "tasks/cancel", { id: "nope" })).json.error.code, -32001);
    const t = (await rpc(h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    const other = await rpc(h, "tasks/get", { id: t.id }, { key: KEY_B, path: "/a2a/anna/" });
    assert.equal(other.json.error.code, -32001);
  });
  it("cancel returns the canceled task; a second cancel is TaskNotCancelable", async () => {
    const { h } = rig({ fake: { gate: never } });
    const t = (await rpc(h, "message/send", sendMsg("x"))).json.result;
    const c = await rpc(h, "tasks/cancel", { id: t.id });
    assert.equal(c.json.result.status.state, "canceled");
    assert.equal((await rpc(h, "tasks/cancel", { id: t.id })).json.error.code, -32002);
  });
  it("task lifecycle is audited", async () => {
    const r = rig();
    await rpc(r.h, "message/send", sendMsg("x", {}, { blocking: true }));
    assert.deepEqual(auditActions(r).filter((a) => a.startsWith("a2a.task.")), ["a2a.task.created", "a2a.task.finished"]);
    const created = r.audit.events.find((e) => e.action === "a2a.task.created")!;
    assert.equal(created.actor.user, "a2a-peer:peer-a"); assert.deepEqual(created.detail, { agent: "bernd", state: "submitted" });
  });
});

describe("streaming", () => {
  it("message/stream answers an SSE response ending in a final status", async () => {
    const { h } = rig();
    const res = await rpcStream(h, "message/stream", sendMsg("hi"));
    assert.equal(res.status, 200); assert.match(res.headers["Content-Type"]!, /^text\/event-stream/);
    assert.equal(res.headers["Cache-Control"], "no-store"); assert.equal(res.body, "");
    const evs = await collectSse(res);
    assert.equal(evs[0].result.kind, "task");
    assert.equal(evs.at(-1).result.final, true); assert.equal(evs.at(-1).result.status.state, "completed");
  });
  it("message/stream with invalid params is a JSON error, not a stream", async () => {
    const { h } = rig();
    const res = await rpcStream(h, "message/stream", { message: {} });
    assert.equal(res.stream, undefined); assert.equal(parse(res).error.code, -32602);
  });
  it("tasks/resubscribe streams a finished task as one final status", async () => {
    const { h } = rig();
    const t = (await rpc(h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    const evs = await collectSse(await rpcStream(h, "tasks/resubscribe", { id: t.id }));
    assert.equal(evs.length, 1); assert.equal(evs[0].result.final, true);
  });
  it("tasks/resubscribe for an unknown task answers TaskNotFound as a JSON-RPC error", { skip: "BUG: Fehler entsteht erst beim Iterieren des SSE-Streams; Antwort ist 200 text/event-stream statt -32001 - siehe docs/testing/coverage-2026-10.md#a2a-handler-resubscribe-unknown-task-stream" }, async () => {
    const { h } = rig();
    const res = await rpcStream(h, "tasks/resubscribe", { id: "nope" });
    assert.equal(parse(res).error.code, -32001);
  });
  it("message/stream over the per-peer stream cap fails inside the stream with a task-limit TaskError", async () => {
    const { h } = rig({ fake: { gate: never }, opts: { limits: { maxStreamConnectionsPerPeer: 1 } } });
    const first = await rpcStream(h, "message/stream", sendMsg("a"));
    const it1 = first.stream![Symbol.asyncIterator](); await it1.next();
    const second = await rpcStream(h, "message/stream", sendMsg("b"));
    await assert.rejects(collectSse(second), (e: unknown) => e instanceof TaskError && e.code === "too-many");
    await it1.return!();
  });
});

describe("push notification methods", () => {
  const started = async (r = rig({ opts: { pushTransport: allowPush } })) => {
    const t = (await rpc(r.h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    return { ...r, t };
  };
  for (const [label, params] of [["undefined", undefined], ["null", null], ["array", []], ["string", "x"]] as [string, unknown][]) {
    it(`params ${label} -> params are required`, async () => {
      const { h } = rig({ opts: { pushTransport: allowPush } });
      const r = await rpc(h, "tasks/pushNotificationConfig/list", params);
      assert.equal(r.json.error.code, -32602); assert.equal(r.json.error.message, "params are required");
    });
  }
  it("a missing or unsafe task id -> task id is required", async () => {
    const { h } = rig({ opts: { pushTransport: allowPush } });
    for (const params of [{}, { id: "" }, { taskId: 5, id: 5 }, { taskId: "a\nb", id: "a".repeat(129) }]) {
      const r = await rpc(h, "tasks/pushNotificationConfig/list", params);
      assert.equal(r.json.error.message, "task id is required");
    }
  });
  it("accepts taskId or id; an unsafe taskId falls back to id; taskId wins when both are valid", async () => {
    const { h, t } = await started();
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/list", { taskId: t.id })).json.result.length, 0);
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/list", { id: t.id })).json.result.length, 0);
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/list", { taskId: "", id: t.id })).json.result.length, 0);
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/list", { taskId: "nope", id: t.id })).json.error.code, -32001);
  });
  it("set rejects malformed configs as invalid params and denied URLs with push-url-denied", async () => {
    const { h, t } = await started();
    for (const pushNotificationConfig of [undefined, null, {}, { url: "" }, { url: "ftp://x/" }, { url: "http://a/", authentication: { schemes: [] } }]) {
      const r = await rpc(h, "tasks/pushNotificationConfig/set", { id: t.id, pushNotificationConfig });
      assert.equal(r.json.error.code, -32602, JSON.stringify(pushNotificationConfig));
    }
    const creds = await rpc(h, "tasks/pushNotificationConfig/set", { id: t.id, pushNotificationConfig: { url: "http://u:p@h/" } });
    assert.equal(creds.json.error.data.reason, "push-url-denied");
    const denyAll = rig();
    const t2 = (await rpc(denyAll.h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    const d = await rpc(denyAll.h, "tasks/pushNotificationConfig/set", { id: t2.id, pushNotificationConfig: { url: "http://h/" } });
    assert.equal(d.json.error.data.reason, "push-url-denied");
  });
  it("get/delete: unknown config ids are TaskNotFound; an unsafe config id on get falls back to the first config", async () => {
    const { h, t } = await started();
    const set = (await rpc(h, "tasks/pushNotificationConfig/set", { id: t.id, pushNotificationConfig: { url: "http://h/1", id: "c1" } })).json.result;
    assert.equal(set.pushNotificationConfig.id, "c1");
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/get", { id: t.id, pushNotificationConfigId: "ghost" })).json.error.code, -32001);
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/get", { id: t.id, pushNotificationConfigId: 5 })).json.result.pushNotificationConfig.id, "c1");
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/get", { id: t.id, pushNotificationConfigId: "c1" })).json.result.pushNotificationConfig.id, "c1");
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/delete", { id: t.id, pushNotificationConfigId: "ghost" })).json.error.code, -32001);
  });
  it("delete needs a config id", async () => {
    const { h, t } = await started();
    for (const pushNotificationConfigId of [undefined, "", 5, "a".repeat(129)]) {
      const r = await rpc(h, "tasks/pushNotificationConfig/delete", { id: t.id, pushNotificationConfigId });
      assert.equal(r.json.error.code, -32602); assert.equal(r.json.error.message, "pushNotificationConfigId is required");
    }
  });
  it("another peer's task is TaskNotFound for every push method", async () => {
    const { h, t } = await started(rig({ opts: { pushTransport: allowPush, peers: withC({ bernd: ["task.push"] }) } }));
    for (const [m, extra] of [["set", { pushNotificationConfig: { url: "http://h/" } }], ["get", {}], ["list", {}], ["delete", { pushNotificationConfigId: "c" }]] as const) {
      const r = await rpc(h, `tasks/pushNotificationConfig/${m}`, { id: t.id, ...extra }, { key: KEY_C });
      assert.equal(r.json.error.code, -32001, m);
    }
  });
  it("a config sent with message/send is delivered when the task finishes", async () => {
    const posted: string[] = [];
    const transport: PushTransport = { decide: allowPush.decide, post: async (a) => { posted.push(a.body); return { status: 204 }; } };
    const r = rig({ opts: { pushTransport: transport } });
    const t = (await rpc(r.h, "message/send", sendMsg("x", {}, { blocking: true, pushNotificationConfig: { url: "http://hook.test/h", token: "tk" } }))).json.result;
    await r.h.tasks.push!.idle();
    assert.equal(posted.length, 1); assert.equal(JSON.parse(posted[0]!).id, t.id);
  });
  it("a pushNotificationConfig with an invalid URL on message/send is invalid params and starts no task", async () => {
    const r = rig({ opts: { pushTransport: allowPush } });
    const res = await rpc(r.h, "message/send", sendMsg("x", {}, { pushNotificationConfig: { url: "nope" } }));
    assert.equal(res.json.error.code, -32602); assert.equal(r.h.tasks.size, 0);
  });
  it("a configured push dispatcher takes precedence over transport and egress", async () => {
    const posted: string[] = [];
    const dispatcher = new PushDispatcher({
      transport: { decide: allowPush.decide, post: async (a) => { posted.push(a.url); return { status: 200 }; } },
      scheduler: new ManualScheduler(), clock: { now: () => 0 }, maxAttempts: 1, backoffMs: 1,
    });
    const r = rig({ opts: { push: dispatcher, pushTransport: { decide: async () => ({ allowed: false, reason: "host-not-allowed", message: "x" }), post: async () => ({ status: 0 }) } } });
    assert.equal(r.h.tasks.push, dispatcher);
    const t = (await rpc(r.h, "message/send", sendMsg("x", {}, { blocking: true, pushNotificationConfig: { url: "http://hook.test/z" } }))).json.result;
    await dispatcher.idle();
    assert.equal(t.status.state, "completed"); assert.deepEqual(posted, ["http://hook.test/z"]);
  });
  it("with an egress policy the URL is admitted through egress.decide", async () => {
    const decided: string[] = [];
    const egress: Egress = {
      decide: async (url) => { decided.push(url); return url.includes("deny") ? { allowed: false, reason: "host-not-allowed", message: "no" } : { allowed: true, host: "h", port: 80, address: "127.0.0.1", family: 4 }; },
      request: async () => { throw new Error("unused"); }, status: () => { throw new Error("unused"); },
    };
    const r = rig({ opts: { egress } });
    const t = (await rpc(r.h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    const ok = await rpc(r.h, "tasks/pushNotificationConfig/set", { id: t.id, pushNotificationConfig: { url: "http://good.test/h" } });
    assert.equal(ok.json.result.pushNotificationConfig.url, "http://good.test/h");
    const no = await rpc(r.h, "tasks/pushNotificationConfig/set", { id: t.id, pushNotificationConfig: { url: "http://deny.test/h" } });
    assert.equal(no.json.error.data.reason, "push-url-denied");
    assert.deepEqual(decided, ["http://good.test/h", "http://deny.test/h"]);
  });
  it("without a scheduler option the default push scheduler drives the retry backoff", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const transport: PushTransport = { decide: allowPush.decide, post: async () => (++calls === 1 ? { status: 503 } : { status: 204 }) };
    const clock = new TestClock();
    const h = createA2aHandler({
      peers: peers(), agents: (id) => AGENTS[id], advertisedBaseUrl: BASE, provider: () => new FakeChatProvider(), clock, pushTransport: transport,
      limits: { pushMaxAttempts: 2, pushBackoffMs: 50 },
    });
    const sent = (await rpc(h, "message/send", sendMsg("x", {}, { blocking: true, pushNotificationConfig: { url: "http://hook.test/r" } }))).json.result;
    for (let i = 0; i < 20 && calls < 1; i++) await tick();
    assert.equal(calls, 1);
    for (let i = 0; i < 5; i++) await tick();
    t.mock.timers.tick(50);
    await h.tasks.push!.idle();
    assert.equal(calls, 2);
    assert.ok(sent.id);
  });
});
