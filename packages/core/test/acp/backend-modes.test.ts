/** CX5 wires mode and custom delivery to advertised Core contracts, never grants selected by an editor. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcError } from "@plur1bus/module-api";
import { CoreSessionBackend, type RpcCaller } from "../../src/acp/backend.ts";

const caller = { channel: "cli", accountId: "host", userId: "owner" } as const;
const methods = ["session.create", "session.submit", "code.session.open", "code.session.mode"];

function rig(options: { queue?: boolean; coding?: boolean; refusal?: boolean; legacy?: boolean } = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const modes = new Map<string, "chat" | "coding">();
  let next = 0;
  const advertised = options.legacy ? [] : [...methods, ...(options.queue ? ["session.queue.list"] : [])];
  const client: RpcCaller = {
    hello: { capabilities: { methods: Object.fromEntries(advertised.map(name => [name, {}])) } },
    call: (async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "session.create") {
        if (options.legacy) assert.equal(params.kind, "direct", "older Core accepts only direct/channel");
        return { session: { id: `s${++next}` } };
      }
      if (method === "code.session.open") {
        if (options.refusal) {
          throw new RpcError("E_APPROVAL_REQUIRED", "private-provider-error", { reason: "root-not-granted" });
        }
        modes.set(String(params.sessionId), "coding");
        return { state: "open", root: "/canonical/work", profile: "coding" };
      }
      if (method === "code.session.mode") {
        const mode = params.mode as "chat" | "coding";
        const changed = modes.get(String(params.sessionId)) !== mode;
        modes.set(String(params.sessionId), mode);
        return { mode, changed };
      }
      if (method === "session.submit") {
        return { state: "steered", futureField: "retained" };
      }
      if (method === "session.archive") {
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    }) as RpcCaller["call"],
  };
  const backend = new CoreSessionBackend({ client, caller, agentId: "worker",
    ...(options.coding ? { initialMode: "coding" as const } : {}) });
  return { backend, calls };
}

test("the real backend binds each ACP cwd through Core and selects independent initial modes", async () => {
  const r = rig();
  assert.equal(r.backend.features?.modes, true);
  const first = await r.backend.createSession({ cwd: "/editor/work" });
  const second = await r.backend.createSession({ cwd: "/editor/other" });
  assert.deepEqual(first, { sessionId: "s1", mode: "chat" });
  assert.deepEqual(second, { sessionId: "s2", mode: "chat" });
  assert.deepEqual(r.calls[1], { method: "code.session.open", params: {
    caller, agentId: "worker", sessionId: "s1", root: "/editor/work", interactive: false,
  } });
  assert.deepEqual(await r.backend.setMode("s1", "coding"), { mode: "coding", changed: true });
  assert.deepEqual(await r.backend.setMode("s2", "chat"), { mode: "chat", changed: false });
  assert.equal(r.calls.some(call => /^(grant\.|approval\.)/.test(call.method)), false);
});

test("the coding startup profile selects coding before returning the new ACP session", async () => {
  const r = rig({ coding: true });
  assert.deepEqual(await r.backend.createSession({ cwd: "/work" }), { sessionId: "s1", mode: "coding" });
  assert.deepEqual(r.calls.at(-1), { method: "code.session.mode", params: {
    caller, sessionId: "s1", mode: "coding",
  } });
});

test("an ungranted ACP cwd produces a fixed typed refusal and archives only the failed new session", async () => {
  const r = rig({ refusal: true });
  await assert.rejects(r.backend.createSession({ cwd: "/work" }), error => {
    assert.equal((error as { reason: string }).reason, "root-not-granted");
    assert.doesNotMatch(String(error), /private-provider-error/);
    return true;
  });
  assert.deepEqual(r.calls.at(-1), { method: "session.archive", params: { caller, sessionId: "s1" } });
  assert.equal(r.calls.some(call => /^(grant\.|approval\.)/.test(call.method)), false);
  await assert.rejects(r.backend.setMode("s1", "coding"), { reason: "unknown-session" });
});

test("custom delivery is absent without the actual queue contract and preserves Core results when available", async () => {
  const absent = rig();
  await absent.backend.createSession({ cwd: "/work" });
  assert.equal(absent.backend.features?.steer, false);
  await assert.rejects(absent.backend.deliver({ sessionId: "s1", text: "change", delivery: "steer" }),
    { reason: "delivery-unavailable" });
  const present = rig({ queue: true });
  await present.backend.createSession({ cwd: "/work" });
  assert.equal(present.backend.features?.steer, true);
  assert.equal(present.backend.features?.followUp, true);
  assert.deepEqual(await present.backend.deliver({ sessionId: "s1", text: " change ", delivery: "queue" }),
    { state: "steered", futureField: "retained" });
  assert.deepEqual(present.calls.at(-1), { method: "session.submit", params: {
    caller, sessionId: "s1", text: " change ", delivery: "queue", wait: false,
  } });
  const count = present.calls.length;
  await assert.rejects(present.backend.deliver({ sessionId: "foreign", text: "x", delivery: "steer" }),
    { reason: "unknown-session" });
  assert.equal(present.calls.length, count);
});

test("an old Core stays a plain ACP backend and cannot silently accept a requested coding profile", async () => {
  const old = rig({ legacy: true });
  assert.equal(old.backend.features?.modes, false);
  assert.deepEqual(await old.backend.createSession({ cwd: "/work" }), { sessionId: "s1" });
  const coding = rig({ legacy: true, coding: true });
  await assert.rejects(coding.backend.createSession({ cwd: "/work" }), { reason: "coding-unavailable" });
  assert.deepEqual(coding.calls, []);
});
