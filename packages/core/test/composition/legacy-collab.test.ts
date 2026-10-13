import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { legacyAdapter } from "../../src/composition/legacy.ts";
import { turnContext } from "../../src/composition/context.ts";
import { composedAgentRunner } from "../../src/composition/collaboration.ts";
import { scopeFor, alsAgentScopePort } from "../../src/collab/index.ts";
import { CollabError } from "../../src/collab/errors.ts";
import type { ChatChunk, ChatProvider, ChatRequest } from "../../src/session/provider.ts";
import type { ChatStreamEvent } from "../../../providers/src/index.ts";
import { useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("p1b-collab-comp-");
const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({ sessionId: "s1", agentId: "a1", summaries: [], memory: "", messages: [{ role: "user", text: "hi" }], signal: new AbortController().signal, ...over });
const provider = (chunks: ChatChunk[], seen: ChatRequest[] = []): ChatProvider => ({ id: "t", async *stream(req) { seen.push(req); for (const c of chunks) yield c; } });
async function drain(adapter: ReturnType<typeof legacyAdapter>, opts?: { signal?: AbortSignal }): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of adapter.stream({ model: "m", messages: [] }, opts as never)) out.push(e);
  return out;
}

describe("composition/legacy legacyAdapter", () => {
  it("fails closed without a turn context", async () => {
    await assert.rejects(() => drain(legacyAdapter(provider([]))), /turn context missing/);
  });

  it("maps deltas to text_delta and ends with one done event carrying the joined text", async () => {
    const events = await turnContext.run(request(), () => drain(legacyAdapter(provider([{ type: "delta", text: "he" }, { type: "delta", text: "llo" }]))));
    assert.deepEqual(events.slice(0, 2), [{ type: "text_delta", text: "he" }, { type: "text_delta", text: "llo" }]);
    const done = events[2] as Extract<ChatStreamEvent, { type: "done" }>;
    assert.equal(events.length, 3);
    assert.equal(done.type, "done");
    assert.equal(done.result.text, "hello");
    assert.equal(done.result.finishReason, "stop");
    assert.deepEqual(done.result.toolCalls, []);
    assert.equal("usage" in done.result, false, "no usage is reported when the provider reported none");
  });

  it("reports usage when the provider gave it, using the last usage chunk", async () => {
    const events = await turnContext.run(request(), () => drain(legacyAdapter(provider([{ type: "usage", inputTokens: 1, outputTokens: 2 }, { type: "usage", inputTokens: 10, outputTokens: 20 }]))));
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    assert.deepEqual(done.result.usage, { inputTokens: 10, outputTokens: 20 });
  });

  it("turns tool.call chunks into tool calls with serialised raw arguments and finishReason tool_calls", async () => {
    const events = await turnContext.run(request(), () => drain(legacyAdapter(provider([
      { type: "tool.call", id: "c1", name: "file.read", args: { path: "a" } },
      { type: "tool.call", id: "c2", name: "file.read", args: undefined },
    ]))));
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    assert.equal(done.result.finishReason, "tool_calls");
    assert.deepEqual(done.result.toolCalls.map((c) => [c.id, c.name, c.argumentsRaw]), [["c1", "file.read", '{"path":"a"}'], ["c2", "file.read", "{}"]], "order and ids are kept, missing args become {}");
  });

  it("ignores tool.result chunks: provider-reported results never reach the pipeline", async () => {
    const events = await turnContext.run(request(), () => drain(legacyAdapter(provider([{ type: "tool.result", id: "c1", output: "redact-probe-alpha" }]))));
    assert.equal(JSON.stringify(events).includes("redact-probe-alpha"), false);
    assert.equal(events.length, 1);
  });

  it("hands the provider the session request, with the adapter's signal taking precedence", async () => {
    const seen: ChatRequest[] = [];
    const turn = request({ memory: "m1", agentId: "agent-x" }); const own = new AbortController();
    await turnContext.run(turn, () => drain(legacyAdapter(provider([], seen)), { signal: own.signal }));
    assert.equal(seen[0]!.agentId, "agent-x"); assert.equal(seen[0]!.memory, "m1");
    assert.equal(seen[0]!.signal, own.signal);
    await turnContext.run(turn, () => drain(legacyAdapter(provider([], seen))));
    assert.equal(seen[1]!.signal, turn.signal, "without an adapter signal the turn's signal is used");
  });

  it("concurrent turns each see their own context", async () => {
    const results = await Promise.all(["a", "b", "c"].map((id) => turnContext.run(request({ agentId: id }), async () => {
      const seen: ChatRequest[] = [];
      await Promise.resolve();
      await drain(legacyAdapter(provider([], seen)));
      return seen[0]!.agentId;
    })));
    assert.deepEqual(results, ["a", "b", "c"]);
  });

  it("a provider error propagates", async () => {
    const bad: ChatProvider = { id: "bad", async *stream() { yield { type: "delta", text: "x" }; throw new Error("provider down"); } };
    await assert.rejects(() => turnContext.run(request(), () => drain(legacyAdapter(bad))), /provider down/);
  });
});

describe("composition/collaboration composedAgentRunner", () => {
  const principal = { userId: "user-1", role: "member" } as never;
  const ctl = () => new AbortController().signal;
  const input = (over: Record<string, unknown> = {}) => ({ agentId: "callee", question: "Q?", context: "CTX", signal: ctl(), principal, ...over }) as never;
  const inScope = <T>(fn: () => Promise<T>, scope = scopeFor("callee", "proj-1")) => alsAgentScopePort().run(scope, fn);

  it("refuses to run outside an AgentScope", async () => {
    const runner = composedAgentRunner(provider([]), alsAgentScopePort(), tmp.make());
    await assert.rejects(() => runner.run(input()), (e) => e instanceof CollabError && e.code === "no-scope");
  });

  it("refuses when the held scope belongs to another agent", async () => {
    const runner = composedAgentRunner(provider([]), alsAgentScopePort(), tmp.make());
    await assert.rejects(() => inScope(() => runner.run(input()), scopeFor("someone-else", "proj-1")), (e) => e instanceof CollabError && e.code === "no-scope");
  });

  it("refuses an unauthenticated caller even inside the right scope", async () => {
    let called = false;
    const runner = composedAgentRunner({ id: "t", async *stream() { called = true; } }, alsAgentScopePort(), tmp.make());
    await assert.rejects(() => inScope(() => runner.run(input({ principal: undefined }))), (e) => e instanceof CollabError && e.code === "no-scope");
    assert.equal(called, false);
  });

  it("calls the provider as the authenticated caller with the scope's project, tool view and no recalled memory", async () => {
    const seen: ChatRequest[] = [];
    const scope = { ...scopeFor("callee", "proj-1"), toolView: ["file.read"] };
    const runner = composedAgentRunner(provider([{ type: "delta", text: "answer" }, { type: "usage", inputTokens: 5, outputTokens: 7 }], seen), alsAgentScopePort(), tmp.make());
    const out = await inScope(() => runner.run(input()), scope);
    assert.deepEqual(out, { text: "answer", inputTokens: 5, outputTokens: 7 });
    const req = seen[0]!;
    assert.equal(req.principal, "user-1");
    assert.equal(req.agentId, "callee");
    assert.equal(req.projectId, "proj-1");
    assert.equal(req.sessionId, "collab:proj-1");
    assert.equal(req.headlessJobId, "collab:proj-1", "headless: a call needing approval gets no prompt");
    assert.deepEqual(req.toolView, ["file.read"]);
    assert.equal(req.memory, ""); assert.deepEqual(req.summaries, []);
    assert.deepEqual(req.messages, [{ role: "user", text: "Q?\n\nCTX" }]);
    assert.match(req.turnId!, /^[0-9a-f-]{36}$/);
  });

  it("each run gets a fresh turn id", async () => {
    const seen: ChatRequest[] = [];
    const runner = composedAgentRunner(provider([], seen), alsAgentScopePort(), tmp.make());
    for (let i = 0; i < 4; i++) await inScope(() => runner.run(input()));
    assert.equal(seen.length, 4);
    assert.equal(new Set(seen.map((r) => r.turnId)).size, 4);
  });

  it("a short answer is returned as is and nothing is written", async () => {
    const home = tmp.make();
    const runner = composedAgentRunner(provider([{ type: "delta", text: "short" }]), alsAgentScopePort(), home);
    assert.equal((await inScope(() => runner.run(input()))).text, "short");
    assert.throws(() => readdirSync(join(home, "state", "subagent-results")), /ENOENT/);
  });

  it("an empty answer is returned as an empty string with zero usage", async () => {
    const runner = composedAgentRunner(provider([]), alsAgentScopePort(), tmp.make());
    assert.deepEqual(await inScope(() => runner.run(input())), { text: "", inputTokens: 0, outputTokens: 0 });
  });

  it("an over-long answer is capped near 2000 tokens with a pointer; the full text stays in a private file", async () => {
    const home = tmp.make();
    const long = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" ");
    const runner = composedAgentRunner(provider([{ type: "delta", text: long }]), alsAgentScopePort(), home);
    const out = await inScope(() => runner.run(input()));
    assert.ok(out.text.length < long.length / 2, "returned text is much shorter");
    assert.ok(out.text.length <= 2000 * 4 + 100, "within the 2000-token limit at ~4 chars/token");
    const m = /\[truncated; full result: (subagent-result:[0-9a-f-]{36})\]$/.exec(out.text);
    assert.ok(m, `pointer marker missing: ${out.text.slice(-120)}`);
    const dir = join(home, "state", "subagent-results");
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(`subagent-result:${files[0]!.replace(/\.json$/, "")}`, m![1]);
    const stored = JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as { principal: string; project: string; value: string };
    assert.deepEqual(stored, { principal: "user-1", project: "proj-1", value: long });
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dir, files[0]!)).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
  });

  it("two capped runs store two separate files", async () => {
    const home = tmp.make();
    const long = "lorem ipsum ".repeat(2000);
    const runner = composedAgentRunner(provider([{ type: "delta", text: long }]), alsAgentScopePort(), home);
    await inScope(() => runner.run(input())); await inScope(() => runner.run(input()));
    assert.equal(readdirSync(join(home, "state", "subagent-results")).length, 2);
  });

  it("stops when the caller's signal aborts mid-stream", async () => {
    const ac = new AbortController();
    const chunks: ChatProvider = { id: "t", async *stream() { yield { type: "delta", text: "a" }; ac.abort(new Error("caller left")); yield { type: "delta", text: "b" }; } };
    const runner = composedAgentRunner(chunks, alsAgentScopePort(), tmp.make());
    await assert.rejects(() => inScope(() => runner.run(input({ signal: ac.signal }))), /caller left/);
  });

  it("a provider failure propagates to the caller", async () => {
    const bad: ChatProvider = { id: "t", async *stream() { throw new Error("no model"); } };
    const runner = composedAgentRunner(bad, alsAgentScopePort(), tmp.make());
    await assert.rejects(() => inScope(() => runner.run(input())), /no model/);
  });
});
