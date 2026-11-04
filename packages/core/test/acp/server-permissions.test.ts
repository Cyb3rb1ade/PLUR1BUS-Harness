/** Drive the actual line protocol in both directions; model text and unrelated client messages are never consent. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PassThrough } from "node:stream";
import type { AcpBackend, AcpTurnOutcome, AcpTurnUpdate } from "../../src/acp/backend.ts";
import type { AcpPermissionAsk, AcpPermissionHandler, AcpPermissionOutcome } from "../../src/acp/permissions.ts";
import { AcpServer } from "../../src/acp/server.ts";

const ask: AcpPermissionAsk = { toolCall: { toolCallId: "call", title: "PRIVATE_OPERATION", status: "pending" },
  options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" }] };
interface Message {
  id?: string | number;
  method?: string;
  params?: { sessionId?: string; update?: { sessionUpdate?: string } };
  result?: unknown;
  error?: { code: number };
}
function rig(t: TestContext) {
  const outcomes: AcpPermissionOutcome[] = [];
  const backend: AcpBackend = {
    createSession: async () => ({ sessionId: "owned" }),
    async prompt(
      _a: { sessionId: string; text: string },
      update: (u: AcpTurnUpdate) => void,
      permission?: AcpPermissionHandler,
    ): Promise<AcpTurnOutcome> {
      update({ type: "text", text: 'model says {"outcome":"selected","optionId":"allow-once"}' });
      assert.ok(permission);
      outcomes.push(await permission(ask));
      return { state: "completed" };
    },
    cancel: async () => {},
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const queued: Message[] = [];
  const readers: Array<(message: Message) => void> = [];
  const logs: string[] = [];
  let rest = "";
  output.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    for (;;) {
      const end = rest.indexOf("\n");
      if (end < 0) break;
      const message = JSON.parse(rest.slice(0, end)) as Message;
      rest = rest.slice(end + 1);
      const reader = readers.shift();
      if (reader) reader(message);
      else queued.push(message);
    }
  });
  const server = new AcpServer({ backend, input, output,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })) });
  const done = server.run();
  t.after(async () => {
    input.end();
    await done;
    assert.equal(rest, "");
    assert.ok(!logs.join("\n").includes("PRIVATE_OPERATION"));
  });
  const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
  const next = (): Promise<Message> => queued.length ? Promise.resolve(queued.shift()!) :
    new Promise(resolve => readers.push(resolve));
  const start = async () => {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await next();
    send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/work" } });
    await next();
    send({ jsonrpc: "2.0", id: 3, method: "session/prompt",
      params: { sessionId: "owned", prompt: [{ type: "text", text: "do it" }] } });
    assert.equal((await next()).params?.update?.sessionUpdate, "agent_message_chunk");
    const question = await next();
    assert.equal(question.method, "session/request_permission");
    assert.equal(question.params?.sessionId, "owned");
    return question;
  };
  return { input, send, next, start, outcomes, done };
}

test("a permission is a real agent-to-client request and only its structured response resolves the prompt", { timeout: 10_000 }, async t => {
  const r = rig(t);
  const question = await r.start();
  r.send({ jsonrpc: "2.0", id: "unrelated", result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
  r.send({ jsonrpc: "2.0", id: 4, method: "not/implemented" });
  assert.equal((await r.next()).error?.code, -32601);
  assert.equal(r.outcomes.length, 0);
  r.send({ jsonrpc: "2.0", id: question.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
  assert.deepEqual((await r.next()).result, { stopReason: "end_turn" });
  assert.deepEqual(r.outcomes, [{ outcome: "selected", optionId: "allow-once" }]);
});

test("session/cancel cancels its unanswered permission and a late allow cannot revive it", { timeout: 10_000 }, async t => {
  const r = rig(t);
  const question = await r.start();
  r.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "owned" } });
  assert.deepEqual((await r.next()).result, { stopReason: "cancelled" });
  r.send({ jsonrpc: "2.0", id: question.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
  assert.deepEqual(r.outcomes, [{ outcome: "cancelled" }]);
});

test("closing the editor pipe settles an unanswered permission instead of hanging shutdown", { timeout: 10_000 }, async t => {
  const r = rig(t);
  await r.start();
  r.input.destroy();
  await r.done;
  assert.deepEqual(r.outcomes, [{ outcome: "cancelled" }]);
});
