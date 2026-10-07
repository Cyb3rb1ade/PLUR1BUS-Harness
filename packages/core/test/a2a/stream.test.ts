import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectSse, http, rpc, rpcStream, sendMsg, rig } from "./helpers.ts";

const never = (): Promise<void> => new Promise(() => {});

describe("message/stream and tasks/resubscribe", () => {
  it("streams status and artifact chunks then a final event and closes", async () => {
    const { h } = rig({ fake: { chunkSize: 8 } });
    const res = await rpcStream(h, "message/stream", sendMsg("hello"));
    assert.equal(res.status, 200);
    assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
    assert.equal(res.headers["Cache-Control"], "no-store");
    const events = await collectSse(res);
    const kinds = events.map((e) => e.result.kind);
    assert.ok(kinds.includes("task"));
    assert.ok(kinds.includes("status-update"));
    assert.ok(kinds.includes("artifact-update"));
    const artifacts = events.filter((e) => e.result.kind === "artifact-update").map((e) => e.result);
    assert.ok(artifacts.length >= 2);
    assert.equal(artifacts[0]!.append, false);
    assert.equal(artifacts.at(-1)!.lastChunk, true);
    const text = artifacts.map((a) => a.artifact.parts[0].text).join("");
    assert.equal(text, "echo[bernd]: hello");
    const finals = events.filter((e) => e.result.kind === "status-update" && e.result.final === true);
    assert.equal(finals.length, 1);
    assert.equal(finals[0]!.result.status.state, "completed");
  });
  it("cancel mid-stream ends the SSE with canceled and does not resume the turn", async () => {
    let aborted = false;
    const { h } = rig({ fake: { gate: async (req) => { req.signal.addEventListener("abort", () => { aborted = true; }); await never(); } } });
    const res = await rpcStream(h, "message/stream", sendMsg("slow"));
    const it = res.stream![Symbol.asyncIterator]();
    const first = JSON.parse((await it.next()).value.slice(6, -2));
    const taskId = first.result.id as string;
    const c = await rpc(h, "tasks/cancel", { id: taskId });
    assert.equal(c.json.result.status.state, "canceled");
    const rest: any[] = [];
    for (;;) {
      const n = await it.next();
      if (n.done) break;
      rest.push(JSON.parse(n.value.slice(6, -2)));
    }
    assert.ok(aborted);
    assert.ok(rest.some((e) => e.result.kind === "status-update" && e.result.final === true && e.result.status.state === "canceled"));
  });
  it("resubscribe after a dropped stream continues from the current snapshot", async () => {
    const { h } = rig({ fake: { gate: never } });
    const sent = await rpc(h, "message/send", sendMsg("slow"));
    const id = sent.json.result.id;
    const first = await rpcStream(h, "tasks/resubscribe", { id });
    const it = first.stream![Symbol.asyncIterator]();
    const snap = JSON.parse((await it.next()).value.slice(6, -2));
    assert.equal(snap.result.kind, "status-update");
    assert.equal(snap.result.status.state, "working");
    await it.return?.();
    const still = await rpc(h, "tasks/get", { id });
    assert.equal(still.json.result.status.state, "working");
    const live = await rpcStream(h, "tasks/resubscribe", { id });
    const it2 = live.stream![Symbol.asyncIterator]();
    const snap2 = JSON.parse((await it2.next()).value.slice(6, -2));
    assert.equal(snap2.result.status.state, "working");
    await it2.return?.();
    await rpc(h, "tasks/cancel", { id });
    const after = await collectSse(await rpcStream(h, "tasks/resubscribe", { id }));
    assert.equal(after[0]!.result.status.state, "canceled");
    assert.equal(after[0]!.result.final, true);
    assert.equal(after.length, 1);
  });
  it("streaming can be turned off on the card and the methods", async () => {
    const { h } = rig({ opts: { features: { streaming: false, pushNotifications: true } } });
    const card = JSON.parse((await http(h, { method: "GET", path: "/a2a/bernd/.well-known/agent-card.json" })).body);
    assert.equal(card.capabilities.streaming, false);
    const res = await rpcStream(h, "message/stream", sendMsg("x"));
    assert.equal(JSON.parse(res.body).error.code, -32004);
  });
});
