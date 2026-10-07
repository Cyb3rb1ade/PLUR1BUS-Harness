import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { CoreSessionBackend, type RpcCaller } from "../../src/acp/backend.ts";
import { AcpServer, type LogFields } from "../../src/acp/server.ts";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import { buildSessionMethods } from "../../src/session/methods.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";

const CALLER = { channel: "cli" as const, accountId: "acc", userId: "u" };
const SECRET = "sk-test-SECRET-0123456789";

/** The real session.* handlers, store and turn loop with the deterministic provider, reached through `call` like the core's RPC. */
function rig(o: { gate?: (i: number) => Promise<void>; maxLineBytes?: number } = {}) {
  const store = new SessionStore({ path: ":memory:" });
  const memory = { recall: async () => ({ text: "", degraded: null }), capture: async () => {}, checkpoint: async () => {} };
  const compactor = new Compactor(store, defaultCompaction(8192), { beforeSwap: async () => {} });
  const runner = new TurnRunner({ store, compactor, memory, provider: () => new FakeChatProvider({ chunkSize: 4, ...(o.gate ? { gate: async (_r, i) => o.gate!(i) } : {}) }) });
  const methods = buildSessionMethods({ store, runner, agents: { workspaceOf: () => "/ws" } as never, isStopping: () => false });
  const calls: string[] = [];
  const client: RpcCaller = { call: async (m, p) => { calls.push(m); return methods[m]!(p ?? {}, { signal: new AbortController().signal } as never) as never; } };
  const backend = new CoreSessionBackend({ client, caller: CALLER, agentId: "bernd", sleep: () => new Promise((r) => setImmediate(r)) });
  const input = new PassThrough(); const output = new PassThrough();
  const logs: string[] = [];
  const server = new AcpServer({ backend, input, output, log: (e, f?: LogFields) => logs.push(JSON.stringify({ e, ...f })), ...(o.maxLineBytes ? { maxLineBytes: o.maxLineBytes } : {}) });
  const done = server.run();
  const out: any[] = []; let buf = "";
  const waiters: Array<() => void> = [];
  output.on("data", (c: Buffer) => { buf += c.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } waiters.splice(0).forEach((w) => w()); });
  const send = (m: unknown) => input.write(`${JSON.stringify(m)}\n`);
  const until = async (pred: () => boolean) => { while (!pred()) await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 5); }); };
  const response = async (id: number | string | null) => { await until(() => out.some((m) => m.id === id && !m.method)); return out.find((m) => m.id === id && !m.method); };
  return { store, calls, input, send, out, logs, done, until, response, rawStdoutRest: () => buf };
}
const init = async (r: ReturnType<typeof rig>) => { r.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }); return r.response(1); };
const newSession = async (r: ReturnType<typeof rig>, id = 2) => { r.send({ jsonrpc: "2.0", id, method: "session/new", params: { cwd: "/work", mcpServers: [] } }); return (await r.response(id)).result.sessionId as string; };
const prompt = (r: ReturnType<typeof rig>, id: number, sessionId: string, text: string) => r.send({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }] } });
const text = (r: ReturnType<typeof rig>) => r.out.filter((m) => m.method === "session/update" && m.params.update.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content.text).join("");

describe("acp server", () => {
  it("handshake: v1, no auth, no load, text-only prompts; a higher client version is answered with 1", async () => {
    const r = rig();
    const res = await init(r);
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.result.protocolVersion, 1);
    assert.deepEqual(res.result.authMethods, []);
    assert.equal(res.result.agentCapabilities.loadSession, false);
    assert.deepEqual(res.result.agentCapabilities.promptCapabilities, { image: false, audio: false, embeddedContext: false });
    r.send({ jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: 2 } });
    assert.equal((await r.response(9)).result.protocolVersion, 1);
    r.input.end(); await r.done;
  });

  it("requests before initialize are refused; session/new needs an absolute cwd", async () => {
    const r = rig();
    r.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/w" } });
    assert.equal((await r.response(1)).error.code, -32600);
    await init(r);
    r.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: "relative" } });
    assert.equal((await r.response(3)).error.code, -32602);
    r.input.end(); await r.done;
  });

  it("session/new creates exactly one harness session of kind acp; a prompt round trip streams ordered chunks, then end_turn", async () => {
    const r = rig();
    await init(r);
    const sid = await newSession(r);
    const stored = r.store.getSession(sid)!;
    assert.deepEqual([stored.kind, stored.agentId], ["acp", "bernd"]);
    prompt(r, 3, sid, "hello world");
    const res = await r.response(3);
    assert.deepEqual(res.result, { stopReason: "end_turn" });
    assert.equal(text(r), "echo[bernd]: hello world");
    const idx = (m: any) => r.out.indexOf(m);
    const updates = r.out.filter((m) => m.method === "session/update");
    assert.ok(updates.length > 1, "streamed in several chunks");
    assert.ok(updates.every((m) => m.params.sessionId === sid && idx(m) < idx(res)), "every update precedes the response");
    assert.deepEqual(r.store.listMessages(sid).map((m) => m.role), ["user", "assistant"], "the turn is a normal, replayable harness turn");
    r.input.end(); await r.done;
  });

  it("tool events are relayed as tool_call / tool_call_update", async () => {
    const r = rig();
    await init(r); const sid = await newSession(r);
    prompt(r, 3, sid, "TOOL please");
    await r.response(3);
    const kinds = r.out.filter((m) => m.method === "session/update").map((m) => m.params.update.sessionUpdate);
    assert.deepEqual(kinds.slice(0, 2), ["tool_call", "tool_call_update"]);
    const call = r.out.find((m) => m.params?.update?.sessionUpdate === "tool_call").params.update;
    assert.deepEqual([call.toolCallId, call.title, call.status], ["t1", "fake.tool", "in_progress"]);
    r.input.end(); await r.done;
  });

  it("session/cancel in the middle of a turn: stopReason cancelled, the harness turn is failed(cancelled), the session is reusable", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const r = rig({ gate: async (i) => { if (i === 3) await gate; } });
    await init(r); const sid = await newSession(r);
    prompt(r, 3, sid, "a long answer please");
    await r.until(() => text(r).length > 0);
    r.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } });
    await r.until(() => r.calls.includes("session.cancel"));
    release();
    assert.deepEqual((await r.response(3)).result, { stopReason: "cancelled" });
    const turn = r.store.listEvents(sid).at(-1)!;
    assert.deepEqual([turn.type, turn.data.error], ["turn.failed", "cancelled"]);
    prompt(r, 4, sid, "again");
    assert.deepEqual((await r.response(4)).result, { stopReason: "end_turn" });
    r.input.end(); await r.done;
  });

  it("a second prompt while one runs is refused; unknown session and non-text blocks are invalid params", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const r = rig({ gate: async (i) => { if (i === 1) await gate; } });
    await init(r); const sid = await newSession(r);
    prompt(r, 3, sid, "first");
    await r.until(() => r.calls.includes("session.submit"));
    prompt(r, 4, sid, "second");
    assert.equal((await r.response(4)).error.data.reason, "turn-in-progress");
    release(); await r.response(3);
    prompt(r, 5, "nope", "x");
    assert.equal((await r.response(5)).error.data.reason, "unknown-session");
    r.send({ jsonrpc: "2.0", id: 6, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "image", data: "AAAA", mimeType: "image/png" }] } });
    const e = (await r.response(6)).error;
    assert.deepEqual([e.code, e.data.reason, e.data.type], [-32602, "unsupported-content-block", "image"]);
    r.send({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "resource_link", name: "a.txt", uri: "file:///a.txt" }] } });
    assert.deepEqual((await r.response(7)).result, { stopReason: "end_turn" });
    assert.match(r.store.listMessages(sid).filter((m) => m.role === "user").at(-1)!.text, /a\.txt file:\/\/\/a\.txt/);
    r.input.end(); await r.done;
  });

  it("a failing turn is a JSON-RPC internal error with a fixed message (the provider's text does not leave the core)", async () => {
    const r = rig();
    await init(r); const sid = await newSession(r);
    prompt(r, 3, sid, "FAIL this");
    const e = (await r.response(3)).error;
    assert.deepEqual([e.code, e.message, e.data.reason], [-32603, "turn failed", "turn-failed"]);
    assert.doesNotMatch(JSON.stringify(r.out), /fake provider failure/);
    r.input.end(); await r.done;
  });

  it("unknown method → -32601 with the id; unknown notification is ignored; garbage → -32700 / -32600", async () => {
    const r = rig();
    await init(r);
    r.send({ jsonrpc: "2.0", id: "x1", method: "session/load", params: {} });
    const e = (await r.response("x1")).error;
    assert.deepEqual([e.code, e.message], [-32601, "method not found"]);
    r.send({ jsonrpc: "2.0", method: "bogus/notify" });
    r.input.write("{not json\n");
    await r.until(() => r.out.some((m) => m.error?.code === -32700));
    r.input.write("[1,2]\n");
    r.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: {}, method: "initialize" })}\n`);
    await r.until(() => r.out.filter((m) => m.error?.code === -32600).length === 2);
    r.send({ jsonrpc: "2.0", id: 50, method: "initialize", params: { protocolVersion: 1 } });
    assert.equal((await r.response(50)).result.protocolVersion, 1, "still serving");
    r.input.end(); await r.done;
  });

  it("line limit: an oversize line gets one -32600 and does not stop the connection", async () => {
    const r = rig({ maxLineBytes: 512 });
    r.input.write(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"pad":"${"x".repeat(2000)}"}}\n`);
    await r.until(() => r.out.length === 1);
    assert.deepEqual([r.out[0].id, r.out[0].error.code, r.out[0].error.data.reason], [null, -32600, "line-too-long"]);
    r.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: 1 } });
    assert.equal((await r.response(2)).result.protocolVersion, 1);
    r.input.end(); await r.done;
  });

  it("no prompt text, model output or secret reaches the log; stdout holds JSON lines only", async () => {
    const r = rig();
    await init(r); const sid = await newSession(r);
    prompt(r, 3, sid, `my key is ${SECRET} FAIL`);
    await r.response(3);
    prompt(r, 4, sid, `again ${SECRET}`);
    await r.response(4);
    r.send({ jsonrpc: "2.0", id: 5, method: `x/${SECRET}`, params: {} });
    await r.response(5);
    assert.ok(r.logs.length > 0);
    assert.doesNotMatch(r.logs.join("\n"), new RegExp(`${SECRET}|echo\\[|my key|fake provider`));
    r.input.end(); await r.done;
    assert.equal(r.rawStdoutRest(), "", "no partial or non-JSON output");
  });

  it("closing the input mid-turn cancels it and run() resolves", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const r = rig({ gate: async (i) => { if (i === 1) await gate; } });
    await init(r); const sid = await newSession(r);
    prompt(r, 3, sid, "never finishes");
    await r.until(() => r.calls.includes("session.submit"));
    r.input.end();
    await r.until(() => r.calls.includes("session.cancel"));
    release(); await r.done;
    assert.equal(r.store.runningTurn(sid), null);
  });
});
