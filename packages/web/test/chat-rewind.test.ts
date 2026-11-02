/** D120 CX1: human rewind/undo actions reload the retained transcript and preserve discarded visibility. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { signal } from "@preact/signals";
import { ChatController } from "../src/pages/chat/controller.ts";
import { addUser, applyEvent, fromResume } from "../src/pages/chat/model.ts";
import { directChatApi } from "../src/pages/chat/api.ts";
import type { Api } from "../src/api/index.ts";
import type { SseEvent } from "../src/api/index.ts";
import { HttpError, RpcError } from "../src/api/errors.ts";

const messages = [
  { id: "m1", seq: 1, role: "user" as const, text: "keep", turnId: "t1", createdAt: 1 },
  { id: "m2", seq: 2, role: "assistant" as const, text: "discarded", turnId: "t1", createdAt: 2, rewound: true },
];

test("harness-command metadata survives resume and marks both sides of a live command turn", () => {
  const resumed = fromResume({ messages: [{ ...messages[0]!, command: true }], runningTurnId: null, lastEventSeq: 1 });
  assert.equal(resumed.entries[0]!.command, true);
  let tr = fromResume({ messages: [messages[0]!], runningTurnId: "t1", lastEventSeq: 0 });
  for (const [seq, type] of [[1, "turn.started"], [2, "turn.completed"]] as const) {
    tr = applyEvent(tr, { sessionId: "s", seq, turnId: "t1", type, data: { provider: "harness-command" }, at: 1 }).tr;
    assert.ok(tr.entries.filter(entry => entry.turnId === "t1").every(entry => entry.command === true));
  }
  const live = applyEvent(fromResume({ messages: [], runningTurnId: null, lastEventSeq: 0 }),
    { sessionId: "s", seq: 1, turnId: "t1", type: "turn.started", data: { provider: "harness-command" }, at: 1 }).tr;
  assert.ok(addUser(live, { id: "late", text: "/compact --explain", turnId: "t1", state: "running" }).entries.every(entry => entry.command));
});

for (const transport of ["rpc", "http"] as const) {
for (const [reason, notice] of [["rewind-target", "chat.rewind.targetError"], ["turn-running", "chat.err.busy"],
  ["rewind-stale", "chat.rewind.staleError"], ["rewind-not-allowed", "chat.rewind.deniedError"], ["unknown-reason", "chat.rewind.error"]] as const) {
  test(`${transport} rewind notice describes ${reason}`, async () => {
    const api = { rpc: async (method: string) => {
      if (method === "session.rewind") throw transport === "rpc" ? new RpcError(-32000, "test", {}, "E_CONFLICT", reason)
        : new HttpError(409, "test", { errorCode: "E_CONFLICT", reason });
      return { session: { id: "s", agentId: "a" }, messages, runningTurnId: null, lastEventSeq: 4 };
    }, events: () => ({ status: signal("connecting"), close() {} }) } as unknown as Api;
    const controller = new ChatController("s", api);
    try { await controller.start(); assert.equal(await controller.rewind({ toSeq: 1 }), false); assert.equal(controller.notice.value, notice); }
    finally { controller.stop(); }
  });
}
}

test("rewound history keeps sequence and visibility metadata for human transcript controls", () => {
  const view = fromResume({ messages, runningTurnId: null, lastEventSeq: 4 });
  assert.deepEqual(view.entries.map(entry => [entry.seq, entry.rewound ?? false]), [[1, false], [2, true]]);
});

test("controller submits an idle rewind or undo and reloads the server's authoritative overlay", async () => {
  const calls: { method: string; params: unknown }[] = [];
  const api = { rpc: async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "session.resume") return { session: { id: "s", agentId: "a" }, messages, rewinds: [],
      runningTurnId: null, lastEventSeq: 4 };
    return { sessionId: "s", rewind: { id: "rew1" } };
  }, events: () => ({ status: signal("connecting"), close() {} }) } as unknown as Api;
  const controller = new ChatController("s", api);
  try {
    await controller.start();
    assert.equal(await controller.rewind({ toSeq: 1 }), true);
    assert.equal(await controller.rewind({ undo: "rew1" }), true);
    assert.deepEqual(calls.filter(call => call.method === "session.rewind").map(call => call.params),
      [{ sessionId: "s", toSeq: 1 }, { sessionId: "s", undo: "rew1" }]);
    assert.equal(calls.filter(call => call.method === "session.resume").length, 3);
    controller.tr.value = { ...controller.tr.value, runningTurnId: "running" };
    assert.equal(await controller.rewind({ toSeq: 1 }), false);
    assert.equal(calls.filter(call => call.method === "session.rewind").length, 2);
  } finally { controller.stop(); }
});

test("the production browser adapter sends rewind data through authenticated chat REST without a caller", async () => {
  const posts: unknown[] = [];
  const base = { post: async (path: string, body: unknown) => { posts.push({ path, body }); return {}; },
    get() {}, patch() {}, put() {}, delete() {}, events() {}, rpc() { throw Error("unexpected generic RPC"); } } as unknown as Api;
  await directChatApi(base).rpc("session.rewind", { sessionId: "session/one", toSeq: 2 });
  assert.deepEqual(posts, [{ path: "/api/v1/chats/session%2Fone/rewind", body: { toSeq: 2 } }]);
});

test("a rewind from another connected surface reloads the active overlay from its live event", async () => {
  let onEvent!: (event: SseEvent) => void;
  let resumes = 0;
  const api = { rpc: async () => {
    resumes++;
    return { session: { id: "s", agentId: "a" }, messages, runningTurnId: null, lastEventSeq: 4, rewinds: [] };
  }, events: (opts: { onEvent: (event: SseEvent) => void }) => {
    onEvent = opts.onEvent;
    return { status: signal("connecting"), close() {} };
  } } as unknown as Api;
  const controller = new ChatController("s", api);
  try {
    await controller.start();
    onEvent({ event: "session.event", data: JSON.stringify({ event: {
      sessionId: "s", seq: 5, turnId: null, type: "session.rewind", data: {}, at: 1,
    } }) });
    assert.equal(resumes, 2);
  } finally { controller.stop(); }
});
