/** ACP v1 mode and extension requests stay scoped to sessions created by this peer. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PassThrough } from "node:stream";
import type { AcpBackend } from "../../src/acp/backend.ts";
import type { AcpMode } from "../../src/acp/modes.ts";
import { AcpServer } from "../../src/acp/server.ts";

interface Message {
  id?: number;
  result?: unknown;
  error?: { code: number };
  params?: { update?: {
    sessionUpdate?: string;
    currentModeId?: string;
    _meta?: Record<string, string>;
    content?: { text?: string };
  } };
}
interface Initialized { agentCapabilities: { _meta: Record<string, unknown> } }
interface Created { modes: { currentModeId: string; availableModes: Array<{ id: string }> } }

function rig(t: TestContext) {
  let mode: AcpMode = "chat";
  const calls: unknown[] = [];
  const output: Message[] = [];
  const waiters: Array<(message: Message) => void> = [];
  const backend: AcpBackend = {
    features: { modes: true, steer: true, followUp: true },
    createSession: async input => {
      calls.push(input);
      return { sessionId: "own", mode };
    },
    setMode: async (sessionId, next) => {
      calls.push({ sessionId, mode: next });
      const changed = mode !== next;
      mode = next;
      return { mode, changed };
    },
    deliver: async input => {
      calls.push(input);
      return { accepted: true, futureField: "preserved" };
    },
    prompt: async () => ({ state: "completed" }), cancel: async () => {},
  };
  const input = new PassThrough();
  const stdout = new PassThrough();
  let rest = "";
  stdout.on("data", (chunk: Buffer) => {
    rest += chunk;
    for (;;) {
      const end = rest.indexOf("\n");
      if (end < 0) break;
      const message = JSON.parse(rest.slice(0, end)) as Message;
      rest = rest.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else output.push(message);
    }
  });
  const server = new AcpServer({ backend, input, output: stdout });
  const done = server.run();
  t.after(async () => {
    input.end();
    await done;
  });
  const send = (id: number, method: string, params: unknown) =>
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const next = (): Promise<Message> => output.length ? Promise.resolve(output.shift()!) :
    new Promise(resolve => waiters.push(resolve));
  const init = async () => {
    send(1, "initialize", { protocolVersion: 1 });
    return (await next()).result as Initialized;
  };
  const create = async () => {
    send(2, "session/new", { cwd: "/work" });
    return (await next()).result as Created;
  };
  return { send, next, init, create, calls };
}

test("session/new supplies cwd to the binding backend and advertises both v1 modes", { timeout: 10_000 }, async t => {
  const r = rig(t);
  await r.init();
  const created = await r.create();
  assert.deepEqual(r.calls, [{ cwd: "/work" }]);
  assert.equal(created.modes.currentModeId, "chat");
  assert.deepEqual(created.modes.availableModes.map(mode => mode.id), ["chat", "coding"]);
});

test("a real mode change emits one cache notice and current mode update; selecting it again emits neither", { timeout: 10_000 }, async t => {
  const r = rig(t);
  await r.init();
  await r.create();
  r.send(3, "session/set_mode", { sessionId: "own", modeId: "coding" });
  const update = await r.next();
  const notice = await r.next();
  const reply = await r.next();
  assert.deepEqual(update.params?.update, { sessionUpdate: "current_mode_update", currentModeId: "coding" });
  assert.equal(notice.params?.update?._meta?.["app.plur1bus/notice"], "profile-changed");
  assert.match(notice.params?.update?.content?.text ?? "", /cache miss/);
  assert.deepEqual(reply, { jsonrpc: "2.0", id: 3, result: {} });
  r.send(4, "session/set_mode", { sessionId: "own", modeId: "coding" });
  assert.deepEqual(await r.next(), { jsonrpc: "2.0", id: 4, result: {} });
});

test("custom delivery is advertised under the exact namespace and passes raw results and text through", { timeout: 10_000 }, async t => {
  const r = rig(t);
  const initialized = await r.init();
  await r.create();
  assert.equal(initialized.agentCapabilities._meta["app.plur1bus/steer"], true);
  assert.equal(initialized.agentCapabilities._meta["app.plur1bus/follow_up"], true);
  for (const [id, method, delivery] of [
    [3, "_app.plur1bus/steer", "steer"], [4, "_app.plur1bus/follow_up", "queue"],
  ] as const) {
    r.send(id, method, { sessionId: "own", prompt: [{ type: "text", text: " keep spaces " }] });
    assert.deepEqual((await r.next()).result, { accepted: true, futureField: "preserved" });
    assert.deepEqual(r.calls.at(-1), { sessionId: "own", text: " keep spaces ", delivery });
  }
});

test("foreign sessions, invalid modes and unsupported custom methods do not reach the backend", { timeout: 10_000 }, async t => {
  const r = rig(t);
  await r.init();
  await r.create();
  for (const [id, method, params, code] of [
    [3, "session/set_mode", { sessionId: "foreign", modeId: "coding" }, -32602],
    [4, "session/set_mode", { sessionId: "own", modeId: "always-approve" }, -32602],
    [5, "_app.plur1bus/steer", { sessionId: "foreign", prompt: [{ type: "text", text: "x" }] }, -32602],
    [6, "_app.unknown/steer", { sessionId: "own" }, -32601],
  ] as const) {
    r.send(id, method, params);
    assert.equal((await r.next()).error?.code, code);
  }
  assert.deepEqual(r.calls, [{ cwd: "/work" }]);
});
