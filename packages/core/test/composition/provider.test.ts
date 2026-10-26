import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TurnToolError, conversationItems, createTurnProvider, toolErrorDetail } from "../../src/composition/provider.ts";
import { collect, readTool, scriptedAdapter, turnFixture, turnRequest, useTempDirs, type ScriptedRound } from "./helpers.ts";
import type { ChatChunk } from "../../src/session/provider.ts";

const tmp = useTempDirs("p1b-turn-comp-");
const call = (id: string, name: string, args: Record<string, unknown> = { path: "x" }) => ({ id, name, args });
type Wire = Awaited<ReturnType<typeof scriptedAdapter>["requests"]>[number]["messages"][number];
const toolCallsOf = (m: Wire) => ("toolCalls" in m && m.toolCalls ? m.toolCalls : []);
const types = (chunks: ChatChunk[]) => chunks.map((c) => c.type === "tool.call" || c.type === "tool.result" ? `${c.type}:${c.id}` : c.type);
async function setup(rounds: ScriptedRound[], extra: Parameters<typeof turnFixture>[1] = {}) {
  const s = scriptedAdapter(rounds);
  const f = turnFixture(s.adapter, extra, tmp.make());
  return { ...s, ...f };
}

describe("composition/provider conversationItems", () => {
  it("gives an assistant turn its text and one tool_use per call; a null text gives no item", () => {
    assert.deepEqual(conversationItems([
      { role: "system", content: "never" },
      { role: "user", content: "read it" },
      { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "file_read", arguments: "{\"path\":\"x\"}" }, { id: "c2", name: "file_read", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "bytes" },
      { role: "tool", toolCallId: "c2", content: "more" },
      { role: "assistant", content: "done", toolCalls: [{ id: "c3", name: "file_read", arguments: "{}" }] },
    ]), [
      { role: "user", kind: "text", text: "read it" },
      { role: "assistant", kind: "tool_use", text: "{\"path\":\"x\"}", id: "c1" },
      { role: "assistant", kind: "tool_use", text: "{}", id: "c2" },
      { role: "user", kind: "tool_result", text: "bytes", id: "c1" },
      { role: "user", kind: "tool_result", text: "more", id: "c2" },
      { role: "assistant", kind: "text", text: "done" },
      { role: "assistant", kind: "tool_use", text: "{}", id: "c3" },
    ]);
  });
});

describe("composition/provider TurnToolError", () => {
  it("carries a code, the original detail, and uses the code as its message", () => {
    const detail = { a: 1 };
    const e = new TurnToolError("tool-unknown", detail);
    assert.ok(e instanceof Error);
    assert.deepEqual([e.name, e.code, e.message, e.detail], ["TurnToolError", "tool-unknown", "tool-unknown", detail]);
  });
});

describe("composition/provider createTurnProvider: admission of a turn", () => {
  it("identifies itself as the composition provider and exposes cache telemetry", async () => {
    const { provider, close } = await setup([{ text: "x" }]);
    try { assert.equal(provider.id, "composition"); assert.equal(typeof provider.telemetry.record, "function"); } finally { close(); }
  });

  it("a turn without any principal is refused before the model is called", async () => {
    const { provider, requests, close } = await setup([{ text: "x" }]);
    try {
      const req = turnRequest(); delete req.principal;
      await assert.rejects(() => collect(provider, req), (e) => e instanceof TurnToolError && e.code === "principal-invalid");
      assert.equal(requests.length, 0);
    } finally { close(); }
  });

  it("an empty-string principal counts as none", async () => {
    const { provider, requests, close } = await setup([{ text: "x" }]);
    try {
      await assert.rejects(() => collect(provider, turnRequest({ principal: "" })), (e) => e instanceof TurnToolError && e.code === "principal-invalid");
      assert.equal(requests.length, 0);
    } finally { close(); }
  });

  it("the principal hook wins over the request's own principal and the caller's request object is left alone", async () => {
    const hookSaw: (string | undefined)[] = [];
    const budgetPrincipals: string[] = [];
    const s = scriptedAdapter([{ text: "x" }]);
    const f = turnFixture(s.adapter, { principal: (r) => { hookSaw.push(r.principal); return "user:resolved"; } }, tmp.make());
    const original = f.budget.checkBeforeCall.bind(f.budget);
    f.budget.checkBeforeCall = (r) => { budgetPrincipals.push(r.principal); return original(r); };
    try {
      const req = turnRequest({ principal: "user:claimed" });
      await collect(f.provider, req);
      assert.deepEqual(hookSaw, ["user:claimed"]);
      assert.deepEqual(budgetPrincipals, ["user:resolved"], "the budget is charged to the resolved principal, not the claimed one");
      assert.equal(req.principal, "user:claimed", "the caller's object is not rewritten");
    } finally { f.close(); }
  });

  it("an unknown profile is refused with the profile name as detail, before the model is called", async () => {
    const { provider, requests, close } = await setup([{ text: "x" }], { profile: "nope" });
    try {
      await assert.rejects(() => collect(provider), (e) => e instanceof TurnToolError && e.code === "unknown_profile" && e.detail === "nope");
      assert.equal(requests.length, 0);
    } finally { close(); }
  });

  it("profileForClass may route the turn to another configured profile; an unconfigured one fails closed", async () => {
    const small = scriptedAdapter([{ text: "from-small" }]); const big = scriptedAdapter([{ text: "from-big" }]);
    const f = turnFixture(small.adapter, {
      profiles: { default: [{ provider: "p1", model: "gpt-4.1", adapter: small.adapter }], big: [{ provider: "p2", model: "gpt-4.1", adapter: big.adapter }] },
      profileForClass: (cls) => cls === "small" ? "big" : undefined,
    }, tmp.make());
    try {
      const chunks = await collect(f.provider, turnRequest({ messages: [{ role: "user", text: "hello" }] }));
      assert.equal(chunks.find((c) => c.type === "delta")?.type, "delta");
      assert.equal(big.requests.length, 1); assert.equal(small.requests.length, 0);
    } finally { f.close(); }
  });

  it("an aborted signal stops the turn before the model is called", async () => {
    const { provider, requests, close } = await setup([{ text: "x" }]);
    try {
      const ac = new AbortController(); const reason = new Error("user cancelled"); ac.abort(reason);
      await assert.rejects(() => collect(provider, turnRequest({ signal: ac.signal })), (e) => e === reason);
      assert.equal(requests.length, 0);
    } finally { close(); }
  });
});

describe("composition/provider createTurnProvider: streaming", () => {
  it("streams deltas as they come and finishes with a usage chunk", async () => {
    const { provider, close } = await setup([{ streamed: ["hel", "lo"], text: "hello", usage: { inputTokens: 7, outputTokens: 3 } }]);
    try {
      const chunks = await collect(provider);
      assert.deepEqual(chunks, [{ type: "delta", text: "hel" }, { type: "delta", text: "lo" }, { type: "usage", inputTokens: 7, outputTokens: 3 }]);
    } finally { close(); }
  });

  // characterization: Ist-Verhalten, nicht spezifiziert. When the final text is longer than what was streamed and starts with
  // it, the remainder is emitted as one extra delta; when it does not start with the streamed text, nothing extra is emitted.
  it("characterization: the unstreamed remainder of the final text is emitted once; a mismatching final text is not", async () => {
    const a = await setup([{ streamed: ["abc"], text: "abcdef" }]);
    try { assert.deepEqual((await collect(a.provider)).filter((c) => c.type === "delta"), [{ type: "delta", text: "abc" }, { type: "delta", text: "def" }]); } finally { a.close(); }
    const b = await setup([{ streamed: ["abc"], text: "xyzxyz" }]);
    try { assert.deepEqual((await collect(b.provider)).filter((c) => c.type === "delta"), [{ type: "delta", text: "abc" }]); } finally { b.close(); }
  });

  it("usage is accumulated over all rounds of a turn", async () => {
    const { provider, registry, close } = await setup([
      { calls: [call("c1", "file.read")], usage: { inputTokens: 10, outputTokens: 1 } },
      { text: "done", usage: { inputTokens: 30, outputTokens: 4 } },
    ]);
    registry.register(readTool("file.read", async () => "ok"));
    try {
      const usage = (await collect(provider)).filter((c) => c.type === "usage");
      assert.deepEqual(usage, [{ type: "usage", inputTokens: 10, outputTokens: 1 }, { type: "usage", inputTokens: 40, outputTokens: 5 }]);
    } finally { close(); }
  });

  it("the wire request carries summaries first, then history with tool messages as user text, then the recalled memory tail", async () => {
    const { provider, requests, close } = await setup([{ text: "ok" }]);
    try {
      await collect(provider, turnRequest({ summaries: ["earlier we discussed X"], memory: "recall-probe-1", messages: [{ role: "user", text: "first" }, { role: "assistant", text: "answer" }, { role: "tool", text: "tool-said" }, { role: "user", text: "latest" }] }));
      const msgs = requests[0]!.messages.map((m) => [m.role, typeof m.content === "string" ? m.content : ""] as const);
      const flat = msgs.map((m) => m[1]);
      assert.ok(flat.indexOf("earlier we discussed X") >= 0);
      assert.ok(flat.indexOf("earlier we discussed X") < flat.indexOf("first"));
      assert.deepEqual(msgs.filter((m) => ["first", "answer", "tool-said", "latest"].includes(m[1])), [["user", "first"], ["assistant", "answer"], ["user", "tool-said"], ["user", "latest"]]);
      const last = msgs.at(-1)!; assert.equal(last[0], "user"); assert.match(last[1], /recall-probe-1/);
      assert.ok(flat.indexOf("latest") < flat.length - 1, "recalled memory comes after the history");
    } finally { close(); }
  });

  it("the memory snapshot is frozen per agent and session: later recalls only reach the volatile tail", async () => {
    const { provider, requests, close } = await setup([{ text: "ok" }]);
    try {
      await collect(provider, turnRequest({ memory: "snapshot-one" }));
      await collect(provider, turnRequest({ memory: "recall-two", turnId: "t2" }));
      const system = (i: number) => requests[i]!.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      assert.match(system(0), /snapshot-one/);
      assert.match(system(1), /snapshot-one/, "the second turn still reads the first turn's snapshot");
      assert.doesNotMatch(system(1), /recall-two/);
      assert.match(String(requests[1]!.messages.at(-1)!.content), /recall-two/);
    } finally { close(); }
  });

  it("a different session gets its own snapshot", async () => {
    const { provider, requests, close } = await setup([{ text: "ok" }]);
    try {
      await collect(provider, turnRequest({ memory: "snapshot-one" }));
      await collect(provider, turnRequest({ memory: "snapshot-two", sessionId: "s2" }));
      assert.match(requests[1]!.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"), /snapshot-two/);
    } finally { close(); }
  });
});

describe("composition/provider createTurnProvider: tool calls", () => {
  it("ChatResult.reasoning is passed as the approval request reason", async () => {
    const token = `password=${["hunter2", "test", "secret"].join("-")}`;
    const asks: { reason?: string }[] = [];
    const { provider, registry, close } = await setup(
      [{ calls: [call("c1", "file.write")], reasoning: `need to write ${token}` }],
      { approval: { request: async (ask) => { asks.push(typeof ask.reason === "string" ? { reason: ask.reason } : {}); return { approved: false }; } } },
    );
    registry.register(readTool("file.write", async () => "ok", {
      capability: "fs.write", effect: "local-write", risk: "medium",
      classify: () => ({ flags: { outsideRoots: true, denyListHit: false } }),
    }));
    try {
      await assert.rejects(() => collect(provider));
      assert.equal(asks.length, 1);
      assert.equal(asks[0]!.reason, `need to write ${token}`);
    } finally { close(); }
  });

  it("several calls in one response run in the order the model gave them, one after the other, with their ids", async () => {
    const order: string[] = [];
    const { provider, registry, requests, close } = await setup([
      { calls: [call("c1", "file.read", { path: "first" }), call("c2", "file.read", { path: "second" }), call("c3", "file.read", { path: "third" })] },
      { text: "done" },
    ]);
    registry.register(readTool("file.read", async (a) => { const p = (a as { path: string }).path; order.push(`start:${p}`); await new Promise((r) => setTimeout(r, p === "first" ? 15 : 1)); order.push(`end:${p}`); return p; }));
    try {
      const chunks = await collect(provider);
      assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second", "start:third", "end:third"], "never concurrent, never reordered");
      assert.deepEqual(types(chunks).filter((t) => t.startsWith("tool.")), ["tool.call:c1", "tool.result:c1", "tool.call:c2", "tool.result:c2", "tool.call:c3", "tool.result:c3"]);
      const second = requests[1]!.messages;
      const assistant = second.find((m) => m.role === "assistant" && toolCallsOf(m).length)!;
      assert.deepEqual(toolCallsOf(assistant).map((c) => c.id), ["c1", "c2", "c3"]);
      assert.deepEqual(second.filter((m) => m.role === "tool").map((m) => "toolCallId" in m ? m.toolCallId : undefined), ["c1", "c2", "c3"]);
    } finally { close(); }
  });

  it("the model sees dot-free tool names and the events and results use the registered names", async () => {
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1", "file.read")] }, { text: "done" }]);
    registry.register(readTool("file.read", async () => "ok"));
    try {
      const chunks = await collect(provider);
      const offered = requests[0]!.tools!.map((t) => t.name);
      assert.deepEqual(offered, ["file_read"]);
      assert.ok(chunks.some((c) => c.type === "tool.call" && c.name === "file.read"));
      const assistant = requests[1]!.messages.find((m) => m.role === "assistant" && toolCallsOf(m).length)!;
      assert.equal(toolCallsOf(assistant)[0]!.name, "file_read", "the history is sent back in the provider's own vocabulary");
    } finally { close(); }
  });

  it("two tools whose wire names would collide (a.b and a_b) refuse the turn before the model is called", async () => {
    const { provider, registry, requests, close } = await setup([{ text: "x" }]);
    registry.register(readTool("tool.a", async () => "1")); registry.register(readTool("tool_a", async () => "2"));
    try {
      await assert.rejects(() => collect(provider), (e) => e instanceof TurnToolError && e.code === "tool-name-collision");
      assert.equal(requests.length, 0);
    } finally { close(); }
  });

  it("a call to a tool that is not registered stops the turn and runs nothing", async () => {
    let ran = 0;
    const { provider, registry, close } = await setup([{ calls: [call("c1", "file.delete")] }]);
    registry.register(readTool("file.read", async () => { ran++; return "ok"; }));
    try {
      await assert.rejects(() => collect(provider), (e) => e instanceof TurnToolError && e.code === "tool-unknown" && e.detail === "file.delete");
      assert.equal(ran, 0);
    } finally { close(); }
  });

  it("a registered tool outside this turn's tool view is treated as unknown and does not run", async () => {
    let ran = 0;
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1", "sys.secret")] }]);
    registry.register(readTool("file.read", async () => "ok"));
    registry.register(readTool("sys.secret", async () => { ran++; return "leak"; }));
    try {
      await assert.rejects(() => collect(provider, turnRequest({ toolView: ["file.read"] })), (e) => e instanceof TurnToolError && e.code === "tool-unknown");
      assert.equal(ran, 0);
      assert.deepEqual(requests[0]!.tools!.map((t) => t.name), ["file_read"], "the hidden tool is not even offered");
    } finally { close(); }
  });

  it("an empty tool view (the default collaboration scope) offers and runs no tools at all", async () => {
    let ran = 0;
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1", "file.read")] }]);
    registry.register(readTool("file.read", async () => { ran++; return "ok"; }));
    try {
      await assert.rejects(() => collect(provider, turnRequest({ toolView: [] })), (e) => e instanceof TurnToolError && e.code === "tool-unknown");
      assert.equal(ran, 0);
      assert.deepEqual(requests[0]!.tools, []);
    } finally { close(); }
  });

  it("a registered tool that the top-k selection did not offer cannot be run by naming it anyway", async () => {
    let ran = 0;
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1", "ops.hidden")] }], { topK: 1 });
    registry.register(readTool("file.read", async () => "ok"));
    for (let i = 0; i < 5; i++) registry.register(readTool(`ops.extra${i}`, async () => "x"));
    registry.register(readTool("ops.hidden", async () => { ran++; return "x"; }));
    try {
      await assert.rejects(() => collect(provider, turnRequest({ messages: [{ role: "user", text: "read the file" }] })), (e) => e instanceof TurnToolError && e.code === "tool-unknown");
      assert.equal(requests[0]!.tools!.length, 1);
      assert.equal(ran, 0);
    } finally { close(); }
  });

  it("an earlier tool in the same response has already run when a later call turns out to be unknown (no rollback)", async () => {
    let ran = 0;
    const { provider, registry, close } = await setup([{ calls: [call("c1", "file.read"), call("c2", "file.delete")] }]);
    registry.register(readTool("file.read", async () => { ran++; return "ok"; }));
    try {
      await assert.rejects(() => collect(provider), (e) => e instanceof TurnToolError && e.code === "tool-unknown");
      assert.equal(ran, 1);
    } finally { close(); }
  });

  // Duplicate ids in one response are made unique deterministically (never merged): the first keeps its id, each later
  // duplicate gets `<id>_<n>` with the smallest n >= 2 not used by any call of the response. Provider id grammars
  // (Anthropic: [a-zA-Z0-9_-]) accept the suffix, and the web chat, which keys tool cards by id, renders every call.
  it("duplicate tool-call ids in one response are made unique deterministically; both run, nothing is merged", async () => {
    const seen: unknown[] = [];
    const { provider, registry, requests, close } = await setup([{ calls: [call("dup", "file.read", { path: "a" }), call("dup", "file.read", { path: "b" })] }, { text: "done" }]);
    registry.register(readTool("file.read", async (a) => { seen.push(a); return "ok"; }));
    try {
      const chunks = await collect(provider);
      assert.deepEqual(seen, [{ path: "a" }, { path: "b" }]);
      assert.deepEqual(types(chunks).filter((t) => t.startsWith("tool.")), ["tool.call:dup", "tool.result:dup", "tool.call:dup_2", "tool.result:dup_2"]);
      const assistant = requests[1]!.messages.find((m) => toolCallsOf(m).length > 0)!;
      assert.deepEqual(toolCallsOf(assistant).map((c) => c.id), ["dup", "dup_2"]);
      assert.deepEqual(requests[1]!.messages.filter((m) => m.role === "tool").map((m) => "toolCallId" in m ? m.toolCallId : undefined), ["dup", "dup_2"]);
    } finally { close(); }
  });

  it("a renamed duplicate never takes an id another call of the same response already uses", async () => {
    const { provider, registry, requests, close } = await setup([{ calls: [call("a", "file.read"), call("a", "file.read"), call("a_2", "file.read"), call("a", "file.read")] }, { text: "done" }]);
    registry.register(readTool("file.read", async () => "ok"));
    try {
      await collect(provider);
      const assistant = requests[1]!.messages.find((m) => toolCallsOf(m).length > 0)!;
      assert.deepEqual(toolCallsOf(assistant).map((c) => c.id), ["a", "a_3", "a_2", "a_4"]);
      assert.deepEqual(requests[1]!.messages.filter((m) => m.role === "tool").map((m) => "toolCallId" in m ? m.toolCallId : undefined), ["a", "a_3", "a_2", "a_4"]);
    } finally { close(); }
  });

  it("the round limit ends a model that keeps calling tools, after exactly that many model calls", async () => {
    let ran = 0;
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1", "file.read")] }], { maxRounds: 3 });
    registry.register(readTool("file.read", async () => { ran++; return "ok"; }));
    try {
      await assert.rejects(() => collect(provider), (e) => e instanceof TurnToolError && e.code === "turn-round-limit" && e.detail === 3);
      assert.equal(requests.length, 3); assert.equal(ran, 3);
    } finally { close(); }
  });

  it("a failing tool ends the turn with the tool's own error code and the original envelope", async () => {
    const { provider, registry, close } = await setup([{ calls: [call("c1", "file.read")] }, { text: "never" }]);
    registry.register(readTool("file.read", async () => { throw Object.assign(new Error("disk gone"), { code: "disk_gone" }); }));
    try {
      await assert.rejects(() => collect(provider), (e) => e instanceof TurnToolError && e.code === "disk_gone" && (e.detail as { isError: boolean }).isError === true);
    } finally { close(); }
  });

  // TurnToolError.detail is a copy of the error envelope whose text is redacted against the registered secrets (and the
  // log redaction rules) and bounded, before any consumer stores or sends it. The text never reaches the model or the stream.
  it("a tool's thrown message is redacted against registered secrets and bounded in TurnToolError.detail", async () => {
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1", "file.read")] }, { text: "never" }], { secrets: () => ["redact-probe-alpha"] });
    registry.register(readTool("file.read", async () => { throw Object.assign(new Error(`upstream said redact-probe-alpha ${"x".repeat(5000)}`), { code: "disk_gone" }); }));
    const chunks: ChatChunk[] = [];
    try {
      await assert.rejects(async () => { for await (const c of provider.stream(turnRequest())) chunks.push(c); }, (e) => {
        assert.ok(e instanceof TurnToolError);
        assert.equal(e.code, "disk_gone");
        const text = JSON.stringify(e.detail);
        assert.equal(text.includes("redact-probe-alpha"), false, "the registered secret is gone");
        assert.match(text, /\[REDACTED:secret\]/);
        assert.ok(text.length <= 4096, `detail is bounded (${text.length})`);
        assert.equal((e.detail as { isError: boolean }).isError, true);
        return true;
      });
      assert.equal(JSON.stringify(chunks).includes("redact-probe-alpha"), false);
      assert.equal(requests.length, 1, "no second model call carries the text");
    } finally { close(); }
  });

  it("toolErrorDetail reduces a bulky envelope (long hint, many issues) to its identity, code and a bounded message", () => {
    const envelope = { callId: "c1", tool: "file.read", isError: true, error: { code: "tool-call-invalid", message: `m redact-probe-alpha ${"y".repeat(900)}`, hint: "h".repeat(20000), issues: Array.from({ length: 500 }, (_, i) => ({ path: `/p${i}`, message: "bad redact-probe-alpha" })) }, provenance: { origin: { system: "tool:file.read", agent: "a1", principal: "p", trust: "builtin" }, hops: 0, transformedBy: [] }, meta: { decision: "none", durationMs: 1, bytes: 0 } };
    const detail = toolErrorDetail(envelope as never, ["redact-probe-alpha"]);
    const text = JSON.stringify(detail);
    assert.ok(text.length <= 4096, `bounded (${text.length})`);
    assert.equal(text.includes("redact-probe-alpha"), false);
    assert.deepEqual([detail.callId, detail.tool, detail.isError, detail.error.code], ["c1", "file.read", true, "tool-call-invalid"]);
    assert.ok(detail.error.message.length <= 500);
    assert.equal(envelope.error.hint.length, 20000, "the original envelope is not modified");
  });

  it("invalid arguments are repaired at most once; a second invalid answer ends the turn with tool-call-invalid", async () => {
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1", "file.read", { path: 7 })] }, { calls: [call("c1", "file.read", { path: 9 })] }]);
    let ran = 0; registry.register(readTool("file.read", async () => { ran++; return "ok"; }));
    try {
      await assert.rejects(() => collect(provider), (e) => e instanceof TurnToolError && e.code === "tool-call-invalid");
      assert.equal(ran, 0);
      assert.equal(requests.length, 2, "one original call plus exactly one repair call");
    } finally { close(); }
  });

  it("extra arguments are rejected against the tool schema and the tool does not run", async () => {
    const { provider, registry, close } = await setup([{ calls: [call("c1", "file.read", { path: "a", force: true })] }, { calls: [call("c1", "file.read", { path: "a", force: true })] }]);
    let ran = 0; registry.register(readTool("file.read", async () => { ran++; return "ok"; }));
    try {
      await assert.rejects(() => collect(provider), (e) => e instanceof TurnToolError && e.code === "tool-call-invalid");
      assert.equal(ran, 0);
    } finally { close(); }
  });

  it("a call that needs a person's approval does not run when the approval port declines", async () => {
    let ran = 0; const asked: unknown[] = [];
    const { provider, registry, close } = await setup([{ calls: [call("c1", "file.read")] }], { approval: { request: async (r) => { asked.push(r); return { approved: false }; } } });
    registry.register(readTool("file.read", async () => { ran++; return "ok"; }, { classify: () => ({ flags: { outsideRoots: true } }) }));
    try {
      await assert.rejects(() => collect(provider), (e) => e instanceof TurnToolError && e.code === "tool-not-approved");
      assert.equal(ran, 0);
      assert.equal(asked.length, 1);
    } finally { close(); }
  });
});

describe("composition/provider createTurnProvider: tool results", () => {
  const big = (n: number) => "x".repeat(n);

  it("a small result is passed to the model as a JSON envelope", async () => {
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1", "file.read")] }, { text: "done" }]);
    registry.register(readTool("file.read", async () => ({ lines: 3 })));
    try {
      await collect(provider);
      const tool = requests[1]!.messages.find((m) => m.role === "tool")!;
      assert.deepEqual(JSON.parse(tool.content as string), { isError: false, value: { lines: 3 }, truncated: false });
    } finally { close(); }
  });

  it("a result above the 32 KiB budget is stored in full and only a short reference goes to the model", async () => {
    const { provider, registry, requests, stored, close } = await setup([{ calls: [call("c1", "file.read")] }, { text: "done" }]);
    const payload = big(50_000);
    registry.register(readTool("file.read", async () => payload));
    try {
      const chunks = await collect(provider);
      const result = chunks.find((c) => c.type === "tool.result")!;
      assert.ok(result.type === "tool.result" && result.output.length < 200, "the output is a reference, not the payload");
      assert.deepEqual(JSON.parse((result as { output: string }).output), { isError: false, truncated: true, reference: "result:1" });
      assert.deepEqual(stored, [payload]);
      const sent = requests[1]!.messages.find((m) => m.role === "tool")!.content as string;
      assert.equal(sent.includes("xxxxxxxx"), false, "none of the payload reaches the model");
    } finally { close(); }
  });

  it("a result at the 32 KiB boundary: just under stays inline, just over is referenced", async () => {
    const run = async (n: number) => {
      const s = await setup([{ calls: [call("c1", "file.read")] }, { text: "done" }]);
      s.registry.register(readTool("file.read", async () => big(n)));
      try { const r = (await collect(s.provider)).find((c) => c.type === "tool.result"); return JSON.parse((r as { output: string }).output) as { truncated: boolean }; } finally { s.close(); }
    };
    const envelope = JSON.stringify({ isError: false, value: "", truncated: false }).length;
    assert.equal((await run(32 * 1024 - envelope)).truncated, false);
    assert.equal((await run(32 * 1024 - envelope + 1)).truncated, true);
  });

  it("a result above the tool's own byte limit is an error, not a reference (the default tool limit is 64 KiB)", async () => {
    const { provider, registry, stored, close } = await setup([{ calls: [call("c1", "file.read")] }]);
    registry.register(readTool("file.read", async () => big(100_000)));
    try {
      await assert.rejects(() => collect(provider), (e) => e instanceof TurnToolError && e.code === "tool-result-too-large");
      assert.deepEqual(stored, [], "an oversized result is dropped rather than stored");
    } finally { close(); }
  });

  it("a tool that declares a larger limit gets the reference path for a result in between", async () => {
    const { provider, registry, stored, close } = await setup([{ calls: [call("c1", "file.read")] }, { text: "done" }]);
    registry.register(readTool("file.read", async () => big(300_000), { limits: { maxResultBytes: 1024 * 1024 } }));
    try {
      await collect(provider);
      assert.equal(stored.length, 1); assert.equal((stored[0] as string).length, 300_000);
    } finally { close(); }
  });

  it("unicode results survive the envelope intact", async () => {
    const { provider, registry, requests, close } = await setup([{ calls: [call("c1", "file.read")] }, { text: "done" }]);
    const text = "Grüße 日本語 😀 \u0000  ";
    registry.register(readTool("file.read", async () => text));
    try {
      await collect(provider);
      assert.equal((JSON.parse(requests[1]!.messages.find((m) => m.role === "tool")!.content as string) as { value: string }).value, text);
    } finally { close(); }
  });
});

describe("composition/provider createTurnProvider: options", () => {
  it("the optional hooks are called with the turn: onPrompt per round, onUsage per settled call", async () => {
    const prompts: number[] = []; const usages: unknown[] = [];
    const { provider, registry, close } = await setup([{ calls: [call("c1", "file.read")] }, { text: "done" }], { onPrompt: () => prompts.push(1), onUsage: (u) => usages.push(u) });
    registry.register(readTool("file.read", async () => "ok"));
    try { await collect(provider); assert.ok(prompts.length >= 2); assert.equal(usages.length, 2); } finally { close(); }
  });

  it("system parts given in the options appear in the system zone of the request", async () => {
    const { provider, requests, close } = await setup([{ text: "ok" }], { system: ["SYSTEM-PROBE-ONE", "SYSTEM-PROBE-TWO"] });
    try {
      await collect(provider);
      const system = requests[0]!.messages.filter((m) => m.role === "system").map((m) => m.content as string).join("\n");
      assert.ok(system.indexOf("SYSTEM-PROBE-ONE") >= 0 && system.indexOf("SYSTEM-PROBE-ONE") < system.indexOf("SYSTEM-PROBE-TWO"));
    } finally { close(); }
  });

  it("maxTokens from the options reaches the wire request", async () => {
    const { provider, requests, close } = await setup([{ text: "ok" }], { maxTokens: 321 });
    try { await collect(provider); assert.equal(requests[0]!.maxTokens, 321); } finally { close(); }
  });

  it("createTurnProvider can be built without ever being called (no I/O at construction)", () => {
    const s = scriptedAdapter([{ text: "x" }]);
    const f = turnFixture(s.adapter, {}, tmp.make());
    try { assert.equal(typeof createTurnProvider, "function"); assert.equal(s.requests.length, 0); } finally { f.close(); }
  });
});
