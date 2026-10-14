import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import type { AcpBackend, AcpTurnOutcome } from "../../src/acp/backend.ts";
import { LineReader } from "../../src/acp/framing.ts";
import { CoreSessionBackend, type RpcCaller } from "../../src/acp/backend.ts";
import { AcpServer } from "../../src/acp/server.ts";

const b = (s: string) => Buffer.from(s, "utf8");
const within = <T>(p: Promise<T>, ms = 1000): Promise<T | "timeout"> => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

function backend(onPrompt?: () => Promise<AcpTurnOutcome>) {
  const cancels: string[] = [];
  const be: AcpBackend = {
    createSession: async () => ({ sessionId: "s1" }),
    prompt: onPrompt ? async () => onPrompt() : async () => ({ state: "completed" }),
    cancel: async (sid) => { cancels.push(sid); },
  };
  return { be, cancels };
}
const line = (m: unknown) => `${JSON.stringify(m)}\n`;

describe("acp audit b02", () => {
  it("framing: a CRLF line of exactly the limit is accepted even when the CR and LF arrive in different chunks", () => {
    const r = new LineReader(6);
    assert.deepEqual(r.push(b("123456\r")), []);
    assert.deepEqual(r.push(b("\n")), [{ line: "123456" }]);
    // one byte more is still refused
    assert.deepEqual(r.push(b("1234567\r")), [{ overflow: true }]);
    assert.deepEqual(r.push(b("\n[1,2]\n")), [{ line: "[1,2]" }]);
  });

  it("framing: an oversize line ending in a lone CR chunk does not swallow the following line", () => {
    const r = new LineReader(4);
    assert.deepEqual(r.push(b("abcdefgh\r")), [{ overflow: true }]);
    assert.deepEqual(r.push(b("\nok\n")), [{ line: "ok" }]);
  });

  it("lifecycle: a destroyed input (close without end) still cancels running turns and ends run()", async () => {
    let release!: (o: AcpTurnOutcome) => void;
    const { be, cancels } = backend(() => new Promise<AcpTurnOutcome>((r) => { release = r; }));
    const input = new PassThrough(); const output = new PassThrough(); output.resume();
    const server = new AcpServer({ backend: be, input, output });
    const done = server.run();
    input.write(line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    input.write(line({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/w" } }));
    await new Promise((r) => setTimeout(r, 30));
    input.write(line({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] } }));
    await new Promise((r) => setTimeout(r, 30));
    input.destroy(new Error("boom"));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(cancels, ["s1"]);
    release({ state: "cancelled" });
    assert.notEqual(await within(done), "timeout", "run() must settle after the input is destroyed");
  });

  it("lifecycle: an error on the output stream (EPIPE) does not crash the process and cancels running turns", async () => {
    let release!: (o: AcpTurnOutcome) => void;
    const { be, cancels } = backend(() => new Promise<AcpTurnOutcome>((r) => { release = r; }));
    const input = new PassThrough();
    const output = new Writable({ write(_c, _e, cb) { cb(); } });
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => { uncaught.push(e); };
    process.on("uncaughtException", onUncaught);
    try {
      const logs: string[] = [];
      const server = new AcpServer({ backend: be, input, output, log: (e) => logs.push(e) });
      const done = server.run();
      input.write(line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
      input.write(line({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/w" } }));
      await new Promise((r) => setTimeout(r, 30));
    input.write(line({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] } }));
      await new Promise((r) => setTimeout(r, 30));
      output.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(uncaught, [], "an unhandled 'error' event on output would crash the adapter");
      assert.deepEqual(cancels, ["s1"], "nobody can read the answer: the running turn is cancelled");
      assert.ok(logs.includes("output-error"));
      release({ state: "cancelled" });
      input.end();
      assert.notEqual(await within(done), "timeout");
    } finally { process.off("uncaughtException", onUncaught); }
  });

  it("backend: a cancel that arrived before submit returned and then fails does not abandon the turn (still followed to its end)", async () => {
    let backendRef!: CoreSessionBackend;
    const calls: string[] = [];
    const client: RpcCaller = {
      call: (async (m: string) => {
        calls.push(m);
        if (m === "session.create") return { session: { id: "s1" } };
        if (m === "session.submit") { void backendRef.cancel("s1"); return { turnId: "t1" }; }
        if (m === "session.cancel") throw new Error("core hiccup");
        if (m === "session.events") return { events: [{ seq: 1, turnId: "t1", type: "turn.failed", data: { error: "cancelled" } }], running: false };
        return {};
      }) as never,
    };
    backendRef = new CoreSessionBackend({ client, caller: { channel: "cli", accountId: "a", userId: "u" }, agentId: "x", sleep: async () => {} });
    await backendRef.createSession();
    const out = await backendRef.prompt({ sessionId: "s1", text: "hi" }, () => {});
    assert.deepEqual(out, { state: "cancelled" });
    assert.ok(calls.includes("session.events"));
  });
});
