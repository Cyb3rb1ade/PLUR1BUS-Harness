/** ACP client replies cannot authorize another request or survive their session/cancellation deadline. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpPermissions, DEFAULT_PERMISSION_TIMEOUT_MS, MAX_PENDING_PERMISSIONS,
  type AcpPermissionAsk } from "../../src/acp/permissions.ts";

interface Request {
  id: string;
  method: string;
  params: { sessionId: string; options: AcpPermissionAsk["options"] };
}

const ask: AcpPermissionAsk = { toolCall: { toolCallId: "tool", title: "Recorded operation", status: "pending" },
  options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" }] };
const cancelled = { outcome: "cancelled" };

test("only the issued request id and one of its offered option ids can resolve a permission", async t => {
  const sent: Request[] = [];
  const broker = new AcpPermissions(message => sent.push(message as Request));
  t.after(() => broker.close());
  const pending = broker.request("session-one", ask);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, "session/request_permission");
  assert.equal(sent[0]!.params.sessionId, "session-one");
  assert.deepEqual(sent[0]!.params.options, ask.options);
  assert.equal(broker.answer({ jsonrpc: "2.0", id: "unissued",
    result: { outcome: { outcome: "selected", optionId: "allow-once" } } }), false);
  assert.equal(broker.pending, 1);
  assert.equal(broker.answer({ jsonrpc: "2.0", id: sent[0]!.id,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } } }), true);
  assert.deepEqual(await pending, { outcome: "selected", optionId: "allow-once" });
  assert.equal(broker.pending, 0);
  assert.equal(broker.answer({ jsonrpc: "2.0", id: sent[0]!.id,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } } }), false);
});

test("unknown options, malformed outcomes and client errors all cancel without interpreting text as approval", async t => {
  const sent: Request[] = [];
  const broker = new AcpPermissions(message => sent.push(message as Request));
  t.after(() => broker.close());
  for (const response of [{ result: { outcome: { outcome: "selected", optionId: "not-offered" } } },
    { result: { outcome: { outcome: "approved", optionId: "allow-once" } } }, { result: "yes" },
    { error: { code: -32603, message: "yes" } }, { result: { outcome: { outcome: "cancelled" } } }]) {
    const pending = broker.request("s", ask);
    assert.ok(sent.length > 0);
    broker.answer({ jsonrpc: "2.0", id: sent.at(-1)!.id, ...response });
    assert.deepEqual(await pending, cancelled);
  }
});

test("session cancellation affects only that session; abort and connection close settle the rest", async () => {
  const sent: Request[] = [];
  const broker = new AcpPermissions(message => sent.push(message as Request));
  const abort = new AbortController();
  const first = broker.request("one", ask);
  const second = broker.request("two", ask, abort.signal);
  broker.cancelSession("one");
  assert.deepEqual(await first, cancelled);
  assert.equal(broker.pending, 1);
  abort.abort();
  assert.deepEqual(await second, cancelled);
  const third = broker.request("three", ask);
  broker.close();
  assert.deepEqual(await third, cancelled);
  assert.deepEqual(await broker.request("closed", ask), cancelled);
  assert.equal(broker.pending, 0);
});

test("the bounded wait expires with fake timers and pending requests cannot grow without bound", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: Request[] = [];
  const broker = new AcpPermissions(message => sent.push(message as Request));
  t.after(() => broker.close());
  const pending = Array.from({ length: MAX_PENDING_PERMISSIONS }, (_, i) => broker.request(`s${i}`, ask));
  assert.equal(broker.pending, MAX_PENDING_PERMISSIONS);
  assert.deepEqual(await broker.request("over-limit", ask), cancelled);
  assert.equal(sent.length, MAX_PENDING_PERMISSIONS);
  t.mock.timers.tick(DEFAULT_PERMISSION_TIMEOUT_MS - 1);
  assert.equal(broker.pending, MAX_PENDING_PERMISSIONS);
  t.mock.timers.tick(1);
  assert.ok((await Promise.all(pending)).every(value => value.outcome === "cancelled"));
  assert.equal(broker.pending, 0);
});

test("the broker supplies the session id, never an extra field on the tool request", async t => {
  const sent: Request[] = [];
  const broker = new AcpPermissions(message => sent.push(message as Request));
  t.after(() => broker.close());
  const contaminated = { ...ask, sessionId: "another-session" };
  const pending = broker.request("owned-session", contaminated);
  assert.equal(sent[0]!.params.sessionId, "owned-session");
  broker.close();
  assert.deepEqual(await pending, cancelled);
});

test("closed input, oversized requests, duplicate options and failed output never leave a pending request", async () => {
  let sent = 0;
  const broker = new AcpPermissions(() => {
    sent++;
    throw new Error("gone");
  });
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await broker.request("s", ask, abort.signal), cancelled);
  assert.deepEqual(await broker.request("s", { ...ask, options: [ask.options[0]!, ask.options[0]!] }), cancelled);
  assert.deepEqual(await broker.request("s", { ...ask, toolCall: { title: "x".repeat(1024 * 1024) } }), cancelled);
  assert.equal(sent, 0);
  assert.deepEqual(await broker.request("s", ask), cancelled);
  assert.equal(sent, 1);
  assert.equal(broker.pending, 0);
  broker.close();
});
