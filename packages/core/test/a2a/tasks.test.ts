import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KEY_B, rig, rpc, sendMsg } from "./helpers.ts";

const never = (): Promise<void> => new Promise(() => {});

describe("message/send, tasks/get, tasks/cancel", () => {
  it("blocking send completes with the fake provider's reply as an artifact", async () => {
    const { h } = rig();
    const r = await rpc(h, "message/send", sendMsg("hello", {}, { blocking: true }));
    assert.equal(r.status, 200);
    const t = r.json.result;
    assert.equal(t.kind, "task"); assert.equal(t.status.state, "completed");
    assert.equal(t.artifacts[0].parts[0].text, "echo[bernd]: hello");
    assert.deepEqual(t.history.map((m: any) => m.role), ["user", "agent"]);
  });
  it("non-blocking send answers working, then tasks/get reports completed", async () => {
    const { h } = rig();
    const sent = await rpc(h, "message/send", sendMsg("hi"));
    assert.equal(sent.json.result.status.state, "working");
    await h.tasks.settled(sent.json.result.id);
    const got = await rpc(h, "tasks/get", { id: sent.json.result.id });
    assert.equal(got.json.result.status.state, "completed");
    assert.equal(got.json.result.contextId, sent.json.result.contextId);
    const noHist = await rpc(h, "tasks/get", { id: sent.json.result.id, historyLength: 0 });
    assert.equal(noHist.json.result.history, undefined);
  });
  it("a provider failure ends failed without leaking its error text", async () => {
    const { h } = rig();
    const r = await rpc(h, "message/send", sendMsg("FAIL please", {}, { blocking: true }));
    assert.equal(r.json.result.status.state, "failed");
    assert.ok(!JSON.stringify(r.json).includes("fake provider failure"));
  });
  it("tool events never reach the peer", async () => {
    const { h } = rig();
    const r = await rpc(h, "message/send", sendMsg("TOOL now", {}, { blocking: true }));
    assert.ok(!JSON.stringify(r.json).includes("fake.tool"));
    assert.equal(r.json.result.status.state, "completed");
  });
  it("cancel aborts the provider, ends canceled and stays canceled", async () => {
    let aborted = false;
    const { h } = rig({ fake: { gate: async (req) => { req.signal.addEventListener("abort", () => { aborted = true; }); await never(); } } });
    const sent = await rpc(h, "message/send", sendMsg("slow"));
    const id = sent.json.result.id;
    const c = await rpc(h, "tasks/cancel", { id });
    assert.equal(c.json.result.status.state, "canceled");
    await h.tasks.settled(id);
    assert.ok(aborted);
    assert.equal((await rpc(h, "tasks/get", { id })).json.result.status.state, "canceled");
    // a second cancel: terminal -> TaskNotCancelable, never a silent success
    assert.equal((await rpc(h, "tasks/cancel", { id })).json.error.code, -32002);
  });
  it("cancelling a completed task is TaskNotCancelable", async () => {
    const { h } = rig();
    const t = (await rpc(h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    assert.equal((await rpc(h, "tasks/cancel", { id: t.id })).json.error.code, -32002);
  });
  it("the reply timeout fails a stuck task", async () => {
    const r = rig({ fake: { gate: never } });
    const sent = await rpc(r.h, "message/send", sendMsg("stuck"));
    assert.equal(r.sched.pending, 1);
    r.sched.fireAll();
    await r.h.tasks.settled(sent.json.result.id);
    const got = (await rpc(r.h, "tasks/get", { id: sent.json.result.id })).json.result;
    assert.equal(got.status.state, "failed");
    assert.match(got.status.message.parts[0].text, /in time/);
  });
  it("unknown task id is TaskNotFound; tasks are private to their peer and agent", async () => {
    const { h } = rig();
    const t = (await rpc(h, "message/send", sendMsg("mine", {}, { blocking: true }))).json.result;
    assert.equal((await rpc(h, "tasks/get", { id: "nope" })).json.error.code, -32001);
    // peer-b has only card.read on bernd; and even with grants it would not see peer-a's task
    assert.equal((await rpc(h, "tasks/get", { id: t.id }, { key: KEY_B })).json.error.code, -32600);
    assert.equal((await rpc(h, "tasks/get", { id: t.id }, { key: KEY_B, path: "/a2a/anna/" })).json.error.code, -32001);
  });
  it("retention: terminal tasks are pruned after the TTL", async () => {
    const r = rig({ opts: { limits: { retentionMs: 1000 } } });
    const t = (await rpc(r.h, "message/send", sendMsg("x", {}, { blocking: true }))).json.result;
    r.clock.advance(1001);
    assert.equal((await rpc(r.h, "tasks/get", { id: t.id })).json.error.code, -32001);
  });
  it("no provider configured is an internal error with a reason, nothing stored", async () => {
    const r = rig({ provider: null });
    const x = await rpc(r.h, "message/send", sendMsg("x"));
    assert.equal(x.json.error.code, -32603); assert.equal(x.json.error.data.reason, "no-provider");
    assert.equal(r.h.tasks.size, 0);
  });
  it("send validation: roles, parts, follow-ups, non-text parts, empty text", async () => {
    const { h } = rig();
    const code = async (p: unknown) => (await rpc(h, "message/send", p)).json.error?.code;
    assert.equal(await code({}), -32602);
    assert.equal(await code({ message: { role: "agent", messageId: "m", parts: [{ kind: "text", text: "x" }] } }), -32602);
    assert.equal(await code({ message: { role: "user", parts: [{ kind: "text", text: "x" }] } }), -32602);
    assert.equal(await code({ message: { role: "user", messageId: "m", parts: [] } }), -32602);
    assert.equal(await code(sendMsg("   ")), -32602);
    assert.equal(await code(sendMsg("x", { taskId: "t1" })), -32004);
    assert.equal(await code({ message: { role: "user", messageId: "m", parts: [{ kind: "file", file: { uri: "file:///etc/passwd" } }] } }), -32005);
    assert.equal(await code(sendMsg("x", { contextId: "bad\nid" })), -32602);
  });
  it("unsupported and unknown methods", async () => {
    const { h } = rig();
    assert.equal((await rpc(h, "message/stream", sendMsg("x"))).json.error.code, -32004);
    assert.equal((await rpc(h, "tasks/pushNotificationConfig/set", {})).json.error.code, -32004);
    assert.equal((await rpc(h, "tasks/list", {})).json.error.code, -32601);
    assert.equal((await rpc(h, "__proto__", {})).json.error.code, -32601);
    assert.equal((await rpc(h, "tasks/get", { id: 5 })).json.error.code, -32602);
    assert.equal((await rpc(h, "tasks/get", { id: "x", historyLength: -1 })).json.error.code, -32602);
  });
  it("send then audit: created and finished are recorded under the peer principal", async () => {
    const { h, audit } = rig();
    await rpc(h, "message/send", sendMsg("x", {}, { blocking: true }));
    const acts = audit.events.map((e) => e.action);
    assert.ok(acts.includes("a2a.task.created") && acts.includes("a2a.task.finished"));
    assert.ok(audit.events.every((e) => e.actor.user === "a2a-peer:peer-a" && e.actor.host === "a2a"));
    assert.ok(!JSON.stringify(audit.events).includes("hello") );
  });
});
