import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import type { AcpBackend, AcpTurnOutcome, AcpTurnUpdate } from "../../src/acp/backend.ts";
import { ACP_PROTOCOL_VERSION, AcpServer, MAX_PROMPT_CHARS, type LogFields } from "../../src/acp/server.ts";

type Msg = Record<string, any>;
interface Fake {
  backend: AcpBackend;
  created: number; cancels: string[]; prompts: { sessionId: string; text: string }[];
  onPrompt: (a: { sessionId: string; text: string }, up: (u: AcpTurnUpdate) => void) => Promise<AcpTurnOutcome>;
  cancelImpl: (sid: string) => Promise<void>;
  createImpl: () => Promise<{ sessionId: string }>;
}
function fakeBackend(): Fake {
  const f: Fake = {
    created: 0, cancels: [], prompts: [],
    onPrompt: async () => ({ state: "completed" }),
    cancelImpl: async () => {},
    createImpl: async () => ({ sessionId: `s${++f.created}` }),
    backend: undefined as never,
  };
  f.backend = {
    createSession: () => f.createImpl(),
    prompt: (a, up) => { f.prompts.push(a); return f.onPrompt(a, up); },
    cancel: (sid) => { f.cancels.push(sid); return f.cancelImpl(sid); },
  };
  return f;
}

function rig(o: { maxLineBytes?: number; agentInfo?: { name: string; title: string; version: string }; output?: Writable } = {}) {
  const fake = fakeBackend();
  const input = new PassThrough(); const output = o.output ?? new PassThrough();
  const logs: { e: string; f?: LogFields | undefined }[] = [];
  const server = new AcpServer({
    backend: fake.backend, input, output: output as never, log: (e, f) => { logs.push({ e, f }); },
    ...(o.maxLineBytes ? { maxLineBytes: o.maxLineBytes } : {}), ...(o.agentInfo ? { agentInfo: o.agentInfo } : {}),
  });
  const done = server.run();
  const out: Msg[] = []; let buf = "";
  const waiters: (() => void)[] = [];
  if (output instanceof PassThrough) output.on("data", (c: Buffer) => { buf += c.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } waiters.splice(0).forEach((w) => w()); });
  const send = (m: unknown) => input.write(`${JSON.stringify(m)}\n`);
  const until = async (pred: () => boolean) => { while (!pred()) await new Promise<void>((r) => { waiters.push(r); setImmediate(r); }); };
  const response = async (id: number | string | null) => { await until(() => out.some((m) => m.id === id && !m.method)); return out.find((m) => m.id === id && !m.method)!; };
  const end = async () => { input.end(); await done; };
  return { fake, input, out, logs, send, response, until, end, done };
}
type Rig = ReturnType<typeof rig>;
const req = (id: number | string | null, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
const init = async (r: Rig) => { r.send(req(1, "initialize", { protocolVersion: 1 })); return r.response(1); };
const newSession = async (r: Rig, id = 2) => { r.send(req(id, "session/new", { cwd: "/w" })); return (await r.response(id)).result.sessionId as string; };
const promptReq = (sessionId: string, prompt: unknown) => ({ sessionId, prompt });
const code = (m: Msg) => m.error.code;

describe("acp server coverage: constants", () => {
  it("exports the protocol version and prompt limit", () => {
    assert.equal(ACP_PROTOCOL_VERSION, 1);
    assert.equal(MAX_PROMPT_CHARS, 200_000);
  });
});

describe("acp server coverage: framing and envelope errors", () => {
  it("a non-JSON line gives -32700 with id null and logs parse-error", async () => {
    const r = rig();
    r.input.write("{not json\n");
    const m = await r.response(null);
    assert.equal(code(m), -32700);
    assert.ok(r.logs.some((l) => l.e === "parse-error"));
    await r.end();
  });
  const invalid: { name: string; msg: unknown }[] = [
    { name: "a JSON array", msg: [] },
    { name: "a JSON number", msg: 5 },
    { name: "null", msg: null },
    { name: "a string", msg: "x" },
    { name: "missing jsonrpc", msg: { id: 1, method: "initialize" } },
    { name: "jsonrpc 1.0", msg: { jsonrpc: "1.0", id: 1, method: "initialize" } },
  ];
  for (const c of invalid) {
    it(`${c.name} gives -32600 with id null`, async () => {
      const r = rig();
      r.send(c.msg);
      const m = await r.response(null);
      assert.equal(code(m), -32600);
      assert.equal(m.error.message, "invalid request");
      await r.end();
    });
  }
  for (const id of [{}, [], true]) {
    it(`id of type ${JSON.stringify(id)} is refused with id null`, async () => {
      const r = rig();
      r.send({ jsonrpc: "2.0", id, method: "initialize" });
      const m = await r.response(null);
      assert.equal(code(m), -32600);
      assert.equal(m.error.message, "invalid request id");
      await r.end();
    });
  }
  it("a message without method and without result/error is invalid, answered with its id (or null without one)", async () => {
    const r = rig();
    r.send({ jsonrpc: "2.0", id: 7 });
    assert.equal(code(await r.response(7)), -32600);
    r.send({ jsonrpc: "2.0" });
    assert.equal(code(await r.response(null)), -32600);
    r.send({ jsonrpc: "2.0", id: 8, method: 5 });
    assert.equal(code(await r.response(8)), -32600);
    await r.end();
  });
  it("client responses (result or error, no method) are ignored silently", async () => {
    const r = rig();
    r.send({ jsonrpc: "2.0", id: 3, result: {} });
    r.send({ jsonrpc: "2.0", id: 4, error: { code: 1, message: "x" } });
    await init(r);
    assert.equal(r.out.length, 1, "only the initialize response");
    await r.end();
  });
  it("an over-long line is refused with line-too-long and the connection stays usable", async () => {
    const r = rig({ maxLineBytes: 200 });
    r.input.write(`${"x".repeat(500)}\n`);
    const m = await r.response(null);
    assert.equal(code(m), -32600);
    assert.deepEqual(m.error.data, { reason: "line-too-long" });
    assert.ok(r.logs.some((l) => l.e === "line-too-long"));
    await init(r);
    await r.end();
  });
  it("string chunks are accepted as well as buffers, and split frames are reassembled", async () => {
    const r = rig();
    const line = JSON.stringify(req(1, "initialize", { protocolVersion: 1 }));
    const input = r.input;
    (input as PassThrough).setEncoding("utf8");
    input.write(line.slice(0, 10));
    input.write(`${line.slice(10)}\n`);
    assert.equal((await r.response(1)).result.protocolVersion, 1);
    await r.end();
  });
  it("an unterminated final line is processed at end of input", async () => {
    const r = rig();
    r.input.write(JSON.stringify(req(1, "initialize", { protocolVersion: 1 })));
    r.input.end();
    await r.done;
    assert.equal(r.out.length, 1);
    assert.equal(r.out[0]!.id, 1);
  });
  it("an input stream error is logged and does not end the run", async () => {
    const r = rig();
    r.input.emit("error", new Error("boom"));
    assert.ok(r.logs.some((l) => l.e === "input-error"));
    await r.end();
  });
  it("a throwing output stream is logged as output-error, not propagated", async () => {
    const bad = new Writable({ write() { throw new Error("closed"); } });
    (bad as unknown as { write: () => never }).write = () => { throw new Error("closed"); };
    const r = rig({ output: bad });
    r.send(req(1, "initialize", { protocolVersion: 1 }));
    await r.until(() => r.logs.some((l) => l.e === "output-error"));
    await r.end();
  });
});

describe("acp server coverage: initialize", () => {
  const bad: { name: string; params: unknown }[] = [
    { name: "no params", params: undefined },
    { name: "array params", params: [] },
    { name: "missing protocolVersion", params: {} },
    { name: "zero", params: { protocolVersion: 0 } },
    { name: "negative", params: { protocolVersion: -1 } },
    { name: "float", params: { protocolVersion: 1.5 } },
    { name: "string", params: { protocolVersion: "1" } },
  ];
  for (const c of bad) {
    it(`protocolVersion ${c.name} gives -32602 and leaves the server uninitialised`, async () => {
      const r = rig();
      r.send(req(1, "initialize", c.params));
      assert.equal(code(await r.response(1)), -32602);
      r.send(req(2, "session/new", { cwd: "/w" }));
      const m = await r.response(2);
      assert.equal(code(m), -32600);
      assert.deepEqual(m.error.data, { reason: "not-initialized" });
      await r.end();
    });
  }
  it("answers the lower of client and agent version, with default and custom agentInfo", async () => {
    const r = rig();
    r.send(req(1, "initialize", { protocolVersion: 1 }));
    const a = await r.response(1);
    assert.deepEqual(a.result.agentInfo, { name: "plur1bus", title: "PLUR1BUS", version: "0.0.0" });
    assert.equal(a.result.protocolVersion, 1);
    r.send(req(2, "initialize", { protocolVersion: 99 }));
    assert.equal((await r.response(2)).result.protocolVersion, 1);
    await r.end();
    const r2 = rig({ agentInfo: { name: "n", title: "T", version: "9" } });
    assert.deepEqual((await init(r2)).result.agentInfo, { name: "n", title: "T", version: "9" });
    await r2.end();
  });
  it("requests are logged by known method name, unknown ones as other", async () => {
    const r = rig();
    await init(r);
    r.send(req(2, "secret/\u0000method-with-data"));
    assert.equal(code(await r.response(2)), -32601);
    const reqs = r.logs.filter((l) => l.e === "request").map((l) => l.f?.method);
    assert.deepEqual(reqs, ["initialize", "other"]);
    await r.end();
  });
  it("an unknown method gives -32601 with a fixed message", async () => {
    const r = rig();
    await init(r);
    r.send(req("abc", "session/load", {}));
    const m = await r.response("abc");
    assert.equal(code(m), -32601);
    assert.equal(m.error.message, "method not found");
    await r.end();
  });
});

describe("acp server coverage: session/new", () => {
  it("before initialize it is refused; prompt too", async () => {
    const r = rig();
    r.send(req(1, "session/prompt", promptReq("s1", [])));
    assert.equal(code(await r.response(1)), -32600);
    await r.end();
  });
  const badNew: { name: string; params: unknown }[] = [
    { name: "no params", params: undefined },
    { name: "missing cwd", params: {} },
    { name: "numeric cwd", params: { cwd: 5 } },
    { name: "relative cwd", params: { cwd: "rel/path" } },
    { name: "dot cwd", params: { cwd: "./x" } },
    { name: "drive-relative Windows cwd", params: { cwd: "C:foo" } },
    { name: "mcpServers not an array", params: { cwd: "/w", mcpServers: {} } },
  ];
  for (const c of badNew) {
    it(`${c.name} gives -32602 and creates no session`, async () => {
      const r = rig();
      await init(r);
      r.send(req(2, "session/new", c.params));
      assert.equal(code(await r.response(2)), -32602);
      assert.equal(r.fake.created, 0);
      await r.end();
    });
  }
  const goodCwd = ["/", "/work/dir", "C:\\Users\\me", "C:/Users/me", "\\\\server\\share\\x", "/ü/日本"];
  for (const cwd of goodCwd) {
    it(`accepts the absolute cwd ${JSON.stringify(cwd)}`, async () => {
      const r = rig();
      await init(r);
      r.send(req(2, "session/new", { cwd }));
      assert.equal((await r.response(2)).result.sessionId, "s1");
      await r.end();
    });
  }
  it("logs only the number of MCP servers", async () => {
    const r = rig();
    await init(r);
    r.send(req(2, "session/new", { cwd: "/w", mcpServers: [{ name: "a", command: "secret" }, { name: "b" }] }));
    await r.response(2);
    r.send(req(3, "session/new", { cwd: "/w" }));
    await r.response(3);
    const logs = r.logs.filter((l) => l.e === "session-new").map((l) => l.f);
    assert.deepEqual(logs, [{ mcpServers: 2 }, { mcpServers: 0 }]);
    assert.ok(!JSON.stringify(r.logs).includes("secret"));
    await r.end();
  });
  it("a backend failure becomes a fixed internal error, logged by class only", async () => {
    const r = rig();
    await init(r);
    r.fake.createImpl = async () => { throw new RangeError("sk-leak-me"); };
    r.send(req(2, "session/new", { cwd: "/w" }));
    const m = await r.response(2);
    assert.equal(code(m), -32603);
    assert.equal(m.error.message, "internal error");
    assert.ok(!JSON.stringify(r.out).includes("sk-leak-me"));
    assert.deepEqual(r.logs.find((l) => l.e === "internal-error")?.f, { name: "RangeError" });
    r.fake.createImpl = async () => { throw "plain"; };
    r.send(req(3, "session/new", { cwd: "/w" }));
    await r.response(3);
    assert.deepEqual(r.logs.filter((l) => l.e === "internal-error").at(-1)?.f, { name: "unknown" });
    await r.end();
  });
});

describe("acp server coverage: session/prompt validation", () => {
  const setup = async () => { const r = rig(); await init(r); const sid = await newSession(r); return { r, sid }; };
  const invalidParams: { name: string; params: (sid: string) => unknown }[] = [
    { name: "no params", params: () => undefined },
    { name: "sessionId not a string", params: () => ({ sessionId: 1, prompt: [] }) },
    { name: "prompt not an array", params: (sid) => ({ sessionId: sid, prompt: "hi" }) },
    { name: "prompt missing", params: (sid) => ({ sessionId: sid }) },
  ];
  for (const c of invalidParams) {
    it(`${c.name} gives -32602`, async () => {
      const { r, sid } = await setup();
      r.send(req(3, "session/prompt", c.params(sid)));
      assert.equal(code(await r.response(3)), -32602);
      assert.equal(r.fake.prompts.length, 0);
      await r.end();
    });
  }
  it("an unknown session gives -32602 with reason unknown-session", async () => {
    const { r } = await setup();
    r.send(req(3, "session/prompt", promptReq("nope", [{ type: "text", text: "x" }])));
    const m = await r.response(3);
    assert.equal(code(m), -32602);
    assert.deepEqual(m.error.data, { reason: "unknown-session" });
    await r.end();
  });
  const blocks: { name: string; prompt: unknown[]; reason?: string; message?: string; text?: string }[] = [
    { name: "non-object block", prompt: ["text"], message: "invalid content block" },
    { name: "null block", prompt: [null], message: "invalid content block" },
    { name: "array block", prompt: [[]], message: "invalid content block" },
    { name: "block without type", prompt: [{ text: "x" }], message: "invalid content block" },
    { name: "numeric type", prompt: [{ type: 1 }], message: "invalid content block" },
    { name: "text block with non-string text", prompt: [{ type: "text", text: 5 }], reason: "unsupported-content-block" },
    { name: "image block", prompt: [{ type: "image", data: "x", mimeType: "image/png" }], reason: "unsupported-content-block" },
    { name: "resource_link without uri", prompt: [{ type: "resource_link", name: "n" }], reason: "unsupported-content-block" },
    { name: "empty prompt array", prompt: [], reason: "prompt-empty" },
    { name: "whitespace-only text", prompt: [{ type: "text", text: " \n\t " }], reason: "prompt-empty" },
    { name: "over the character limit", prompt: [{ type: "text", text: "a".repeat(MAX_PROMPT_CHARS + 1) }], reason: "prompt-too-long" },
    { name: "limit exceeded only by joining blocks", prompt: [{ type: "text", text: "a".repeat(MAX_PROMPT_CHARS) }, { type: "text", text: "b" }], reason: "prompt-too-long" },
  ];
  for (const c of blocks) {
    it(`${c.name} gives -32602`, async () => {
      const { r, sid } = await setup();
      r.send(req(3, "session/prompt", promptReq(sid, c.prompt)));
      const m = await r.response(3);
      assert.equal(code(m), -32602);
      if (c.reason) assert.equal(m.error.data.reason, c.reason);
      if (c.message) assert.equal(m.error.message, c.message);
      assert.equal(r.fake.prompts.length, 0);
      await r.end();
    });
  }
  it("a prompt of exactly the limit is accepted", async () => {
    const { r, sid } = await setup();
    r.send(req(3, "session/prompt", promptReq(sid, [{ type: "text", text: "a".repeat(MAX_PROMPT_CHARS) }])));
    assert.deepEqual((await r.response(3)).result, { stopReason: "end_turn" });
    await r.end();
  });
  it("an unsupported block type is reported by a sanitised, truncated name", async () => {
    const { r, sid } = await setup();
    const type = `au\u0000dio-é${"x".repeat(100)}`;
    r.send(req(3, "session/prompt", promptReq(sid, [{ type }])));
    const m = await r.response(3);
    assert.equal(m.error.data.reason, "unsupported-content-block");
    assert.match(m.error.data.type, /^au\?dio-\?x+\?$/, "non-printable and the ellipsis become ?");
    assert.equal(m.error.data.type.length, 65);
    await r.end();
  });
  it("text blocks are joined with newlines; resource links are rendered with and without a name", async () => {
    const { r, sid } = await setup();
    r.send(req(3, "session/prompt", promptReq(sid, [
      { type: "text", text: "one" },
      { type: "resource_link", uri: "file:///a.txt", name: "a.txt" },
      { type: "resource_link", uri: "file:///b.txt" },
      { type: "resource_link", uri: "file:///c.txt", name: 5 },
      { type: "resource_link", uri: "", name: "empty-uri" },
      { type: "text", text: "two" },
    ])));
    await r.response(3);
    assert.equal(r.fake.prompts[0]!.text, "one\n[resource: a.txt file:///a.txt]\n[resource:  file:///b.txt]\n[resource:  file:///c.txt]\n[resource: empty-uri]\ntwo");
    await r.end();
  });
});

describe("acp server coverage: resource link rendering", () => {
  it("UNKLAR: a resource link without a name is rendered with a single space", { skip: "UNKLAR: soll der Name leer bleiben dürfen (doppeltes Leerzeichen) – siehe docs/testing/coverage-2026-10.md#acp-resource-link-double-space" }, async () => {
    const r = rig(); await init(r); const sid = await newSession(r);
    r.send(req(3, "session/prompt", promptReq(sid, [{ type: "resource_link", uri: "file:///b.txt" }])));
    await r.response(3);
    assert.equal(r.fake.prompts[0]!.text, "[resource: file:///b.txt]");
    await r.end();
  });
});

describe("acp server coverage: prompt turns", () => {
  const setup = async () => { const r = rig(); await init(r); const sid = await newSession(r); return { r, sid }; };
  const text = (sid: string) => promptReq(sid, [{ type: "text", text: "hi" }]);
  it("maps outcomes: completed to end_turn, cancelled to cancelled, failed to a fixed internal error", async () => {
    const { r, sid } = await setup();
    r.send(req(3, "session/prompt", text(sid)));
    assert.deepEqual((await r.response(3)).result, { stopReason: "end_turn" });
    r.fake.onPrompt = async () => ({ state: "cancelled" });
    r.send(req(4, "session/prompt", text(sid)));
    assert.deepEqual((await r.response(4)).result, { stopReason: "cancelled" });
    r.fake.onPrompt = async () => ({ state: "failed", error: "sk-secret provider text" });
    r.send(req(5, "session/prompt", text(sid)));
    const m = await r.response(5);
    assert.equal(code(m), -32603);
    assert.equal(m.error.message, "turn failed");
    assert.deepEqual(m.error.data, { reason: "turn-failed" });
    assert.ok(!JSON.stringify([r.out, r.logs]).includes("sk-secret"));
    assert.deepEqual(r.logs.filter((l) => l.e === "prompt-done").map((l) => l.f), [{ state: "completed" }, { state: "cancelled" }, { state: "failed" }]);
    await r.end();
  });
  it("a backend rejection is an internal error and frees the session for the next prompt", async () => {
    const { r, sid } = await setup();
    r.fake.onPrompt = async () => { throw new Error("kaputt"); };
    r.send(req(3, "session/prompt", text(sid)));
    assert.equal(code(await r.response(3)), -32603);
    r.fake.onPrompt = async () => ({ state: "completed" });
    r.send(req(4, "session/prompt", text(sid)));
    assert.deepEqual((await r.response(4)).result, { stopReason: "end_turn" });
    await r.end();
  });
  it("streams text, tool.call (with and without args) and tool.result as session/update before the response", async () => {
    const { r, sid } = await setup();
    r.fake.onPrompt = async (_a, up) => {
      up({ type: "text", text: "hel" });
      up({ type: "tool.call", id: "c1", name: "search", args: { q: "x" } });
      up({ type: "tool.call", id: "c2", name: "noargs" });
      up({ type: "tool.call", id: "c3", name: "falsy", args: 0 });
      up({ type: "tool.result", id: "c1", output: "found" });
      return { state: "completed" };
    };
    r.send(req(3, "session/prompt", text(sid)));
    const res = await r.response(3);
    const ups = r.out.filter((m) => m.method === "session/update");
    assert.equal(ups.length, 5);
    assert.ok(ups.every((m) => m.params.sessionId === sid && r.out.indexOf(m) < r.out.indexOf(res)));
    assert.deepEqual(ups[0]!.params.update, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hel" } });
    assert.deepEqual(ups[1]!.params.update, { sessionUpdate: "tool_call", toolCallId: "c1", title: "search", kind: "other", status: "in_progress", rawInput: { q: "x" } });
    assert.ok(!("rawInput" in ups[2]!.params.update));
    assert.equal(ups[3]!.params.update.rawInput, 0);
    assert.deepEqual(ups[4]!.params.update, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "found" } }] });
    await r.end();
  });
  it("a second prompt on a running session gets -32000 turn-in-progress; other sessions are unaffected", async () => {
    const { r, sid } = await setup();
    const sid2 = await newSession(r, 10);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    r.fake.onPrompt = async (a) => { if (a.sessionId === sid) await gate; return { state: "completed" }; };
    r.send(req(3, "session/prompt", text(sid)));
    await r.until(() => r.fake.prompts.length === 1);
    r.send(req(4, "session/prompt", text(sid)));
    const busy = await r.response(4);
    assert.equal(code(busy), -32000);
    assert.deepEqual(busy.error.data, { reason: "turn-in-progress" });
    r.send(req(5, "session/prompt", text(sid2)));
    assert.deepEqual((await r.response(5)).result, { stopReason: "end_turn" });
    release();
    assert.deepEqual((await r.response(3)).result, { stopReason: "end_turn" });
    await r.end();
  });
});

describe("acp server coverage: cancel", () => {
  const setup = async () => { const r = rig(); await init(r); const sid = await newSession(r); return { r, sid }; };
  const text = (sid: string) => promptReq(sid, [{ type: "text", text: "hi" }]);
  it("session/cancel on a running prompt calls the backend and the prompt ends cancelled even if the backend says completed", async () => {
    const { r, sid } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    r.fake.onPrompt = async () => { await gate; return { state: "completed" }; };
    r.send(req(3, "session/prompt", text(sid)));
    await r.until(() => r.fake.prompts.length === 1);
    r.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } });
    await r.until(() => r.fake.cancels.length === 1);
    assert.deepEqual(r.fake.cancels, [sid]);
    assert.deepEqual(r.logs.find((l) => l.e === "cancel")?.f, { running: true });
    release();
    assert.deepEqual((await r.response(3)).result, { stopReason: "cancelled" });
    await r.end();
  });
  it("cancel for an idle, unknown or malformed target does nothing (and is logged as not running)", async () => {
    const { r, sid } = await setup();
    r.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } });
    r.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "nope" } });
    r.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: 5 } });
    r.send({ jsonrpc: "2.0", method: "session/cancel", params: [] });
    r.send({ jsonrpc: "2.0", method: "session/cancel" });
    await r.end();
    assert.deepEqual(r.fake.cancels, []);
    assert.deepEqual(r.logs.filter((l) => l.e === "cancel").map((l) => l.f), Array(5).fill({ running: false }));
  });
  it("a cancel with an id is a request, not a notification: method not found", async () => {
    const { r, sid } = await setup();
    r.send(req(9, "session/cancel", { sessionId: sid }));
    assert.equal(code(await r.response(9)), -32601);
    await r.end();
  });
  it("a failing backend cancel is logged as cancel-failed", async () => {
    const { r, sid } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    r.fake.onPrompt = async () => { await gate; return { state: "cancelled" }; };
    r.fake.cancelImpl = async () => { throw new Error("nope"); };
    r.send(req(3, "session/prompt", text(sid)));
    await r.until(() => r.fake.prompts.length === 1);
    r.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } });
    await r.until(() => r.logs.some((l) => l.e === "cancel-failed"));
    release();
    await r.response(3);
    await r.end();
  });
  it("other notifications are ignored, logged by known name or other", async () => {
    const { r } = await setup();
    r.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { id: 1 } });
    r.send({ jsonrpc: "2.0", method: "initialize" });
    await r.end();
    assert.deepEqual(r.logs.filter((l) => l.e === "notification-ignored").map((l) => l.f), [{ method: "other" }, { method: "initialize" }]);
    assert.equal(r.out.filter((m) => m.id === undefined && !m.method).length, 0);
  });
  it("end of input cancels prompts still running, waits for them, and survives a failing backend cancel", async () => {
    const { r, sid } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    r.fake.onPrompt = async () => { await gate; return { state: "completed" }; };
    r.fake.cancelImpl = async () => { throw new Error("late"); };
    r.send(req(3, "session/prompt", text(sid)));
    await r.until(() => r.fake.prompts.length === 1);
    r.input.end();
    await r.until(() => r.fake.cancels.length === 1);
    let finished = false;
    void r.done.then(() => { finished = true; });
    await new Promise<void>((res) => setImmediate(res));
    assert.equal(finished, false, "run waits for the in-flight prompt");
    release();
    await r.done;
    assert.deepEqual(r.out.find((m) => m.id === 3)?.result, { stopReason: "cancelled" });
  });
});
