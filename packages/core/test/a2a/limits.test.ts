import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rig, http, rpc, sendMsg, KEY_A, KEY_B } from "./helpers.ts";

const never = (): Promise<void> => new Promise(() => {});
const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tasks/get", params: { id: "x" } });

describe("size, type and rate limits", () => {
  it("a body over the cap is 413, declared or streamed, and nothing runs", async () => {
    const r = rig({ opts: { limits: { maxBodyBytes: 512 } } });
    const big = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: sendMsg("x".repeat(2000)) }));
    const declared = await http(r.h, { path: "/a2a/bernd/", raw: big, headers: { "content-type": "application/json", "content-length": String(big.length) } });
    assert.equal(declared.status, 413);
    const streamed = await http(r.h, { path: "/a2a/bernd/", raw: big, headers: { "content-type": "application/json" } });
    assert.equal(streamed.status, 413);
    assert.equal(r.h.tasks.size, 0);
    assert.ok(r.audit.events.some((e) => e.action === "a2a.too-large"));
  });
  it("an unauthenticated oversized body is refused before it is read", async () => {
    const r = rig({ opts: { limits: { maxBodyBytes: 16 } } });
    let read = false;
    const res = await r.h.handle({ method: "POST", path: "/a2a/bernd/", headers: { "content-type": "application/json" }, remote: "1.1.1.1", readBody: async () => { read = true; return Buffer.alloc(0); } });
    assert.equal(res.status, 401); assert.equal(read, false);
  });
  it("a message text over the cap is invalid params; invalid Content-Length and media type are refused", async () => {
    const r = rig({ opts: { limits: { maxTextBytes: 100 } } });
    const t = await rpc(r.h, "message/send", sendMsg("é".repeat(60)));
    assert.equal(t.json.error.code, -32602); assert.equal(t.json.error.data.reason, "text-too-large");
    const many = await rpc(r.h, "message/send", { message: { role: "user", messageId: "m", parts: Array.from({ length: 17 }, () => ({ kind: "text", text: "a" })) } });
    assert.equal(many.json.error.data.reason, "too-many-parts");
    assert.equal((await http(r.h, { path: "/a2a/bernd/", raw: Buffer.from("{}"), headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal((await http(r.h, { path: "/a2a/bernd/", raw: Buffer.from("{}"), headers: { "content-type": "application/json", "content-length": "12abc" } })).status, 413);
  });
  it("malformed JSON, batches and bad envelopes are JSON-RPC errors", async () => {
    const { h } = rig();
    const raw = async (b: string) => JSON.parse((await http(h, { path: "/a2a/bernd/", raw: Buffer.from(b), headers: { "content-type": "application/json" } })).body);
    assert.equal((await raw("{nope")).error.code, -32700);
    const batch = await raw(JSON.stringify([call(1), call(2)]));
    assert.equal(batch.error.code, -32600); assert.equal(batch.error.data.reason, "batch");
    assert.equal((await raw(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tasks/get" }))).error.code, -32600);
    assert.equal((await raw(JSON.stringify({ jsonrpc: "2.0", method: "tasks/get", params: { id: "x" } }))).error.code, -32600); // a notification: no id
    assert.equal((await raw("null")).error.code, -32600);
  });
  it("per-peer rate limit answers 429 with Retry-After, is per peer, audited and refills", async () => {
    const r = rig({ opts: { limits: { peerRatePerMinute: 3 } } });
    for (let i = 0; i < 3; i++) assert.equal((await http(r.h, { path: "/a2a/bernd/", body: call(i + 1) })).status, 200);
    const limited = await http(r.h, { path: "/a2a/bernd/", body: call(9) });
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers["Retry-After"]) >= 1);
    // another peer keeps its own budget
    assert.equal((await http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json", key: KEY_B })).status, 200);
    assert.ok(r.audit.events.some((e) => e.action === "a2a.rate-limited" && e.detail.scope === "peer" && e.actor.user === "a2a-peer:peer-a"));
    r.clock.advance(20_000);
    assert.equal((await http(r.h, { path: "/a2a/bernd/", body: call(10) })).status, 200);
  });
  it("per-address rate limit applies to every caller behind it", async () => {
    const r = rig({ opts: { limits: { addressRatePerMinute: 2 } } });
    assert.equal((await http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json", remote: "9.9.9.9" })).status, 200);
    assert.equal((await http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json", key: KEY_B, remote: "9.9.9.9" })).status, 200);
    assert.equal((await http(r.h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json", key: KEY_A, remote: "9.9.9.9" })).status, 429);
  });
  it("live task cap per peer: the (n+1)th running task is refused, a finished one frees a slot", async () => {
    const r = rig({ fake: { gate: never }, opts: { limits: { maxLiveTasksPerPeer: 2 } } });
    const a = (await rpc(r.h, "message/send", sendMsg("1"))).json.result.id;
    await rpc(r.h, "message/send", sendMsg("2"));
    const third = await rpc(r.h, "message/send", sendMsg("3"));
    assert.equal(third.json.error.code, -32000); assert.equal(third.json.error.data.reason, "task-limit");
    await rpc(r.h, "tasks/cancel", { id: a });
    assert.ok((await rpc(r.h, "message/send", sendMsg("4"))).json.result.id);
  });
  it("the stored-task cap refuses new work instead of evicting live tasks", async () => {
    const r = rig({ opts: { limits: { maxStoredTasks: 1 } } });
    await rpc(r.h, "message/send", sendMsg("1", {}, { blocking: true }));
    assert.equal((await rpc(r.h, "message/send", sendMsg("2"))).json.error.code, -32000);
  });
});
