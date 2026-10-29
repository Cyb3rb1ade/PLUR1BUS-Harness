/** F1 memory tools preserve the admitted caller and agent and pass effects through the dispatcher. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { createMemoryTools } from "../../src/tools/memory.ts";
import { ToolDispatcher, type DispatchContext } from "../../src/tools/dispatcher.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { engineTurnMemory, type TurnMemory } from "../../src/session/memory-port.ts";
import type { ChatRequest } from "../../src/session/provider.ts";
import { CAPABILITIES } from "../../src/policy/index.ts";
import { defaults } from "@plur1bus/config-schema";
import { channelBehaviour } from "../../src/channels/behaviour-context.ts";
import { resolveBehaviour } from "../../src/channels/behaviour.ts";
import { runWithAgentScope, scopeFor } from "../../src/agents/scope.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import type { HarnessLogger } from "../../src/logger.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const caller = { channel: "cli" as const, accountId: "account", userId: "caller" };
function rig(over: Partial<ChatRequest> = {}, approval = false, requireApproval = false) {
  const recalls: Parameters<TurnMemory["recall"]>[0][] = [];
  const captures: Parameters<TurnMemory["capture"]>[0][] = [];
  const memory: TurnMemory = {
    async recall(args) { recalls.push(args); return { text: "remembered", degraded: null }; },
    async capture(args) { captures.push(args); },
    async checkpoint() {},
  };
  const req: ChatRequest = {
    agentId: "agent", sessionId: "session", turnId: "turn", caller, authenticatedPerson: "person",
    principal: "principal", messages: [], summaries: [], memory: "", signal: new AbortController().signal,
    ...over,
  };
  const registry = new ToolRegistry();
  const tools = createMemoryTools(memory, req);
  for (const tool of tools) registry.register(tool);
  let approvals = 0;
  const dispatcher = new ToolDispatcher({
    registry, clock: { now: () => 1000 }, grants: { list: () => [], get: () => undefined },
    approvals: { request: async () => { approvals++; return { approved: approval }; } },
    ...(requireApproval ? { policyContext: () => ({ overrides: { "memory.write": "approval" as const } }) } : {}),
  });
  const context: DispatchContext = {
    agentId: req.agentId, principal: req.principal!, sessionId: req.sessionId, surface: 3, signal: req.signal,
  };
  const call = (name: string, args: unknown, extra: Partial<DispatchContext> = {}) =>
    dispatcher.call({ id: "call", name, args }, { ...context, ...extra });
  return { req, tools, calls: { recalls, captures }, call, approvals: () => approvals };
}

it("recalls through the bound TurnMemory port with the original caller, identity and abort signal", async () => {
  const stop = new AbortController();
  const r = rig({ signal: stop.signal });
  const result = await r.call("memory.recall", { query: "what was decided?" });
  assert.equal(result.isError, false);
  if (!result.isError) assert.deepEqual(result.value, { text: "remembered", degraded: null });
  const { signal, ...args } = r.calls.recalls[0]!;
  assert.deepEqual(args, {
    agentId: "agent", caller, authenticatedPerson: "person", query: "what was decided?",
  });
  assert.equal(signal.aborted, false);
  stop.abort();
  assert.equal(signal.aborted, true, "dispatcher timeout signal remains linked to the original turn signal");
  assert.equal(r.approvals(), 0);
});

it("captures assistant-authored text in this session without consuming the automatic turn capture id", async () => {
  const r = rig();
  assert.equal((await r.call("memory.capture", { text: "A decision to remember." })).isError, false);
  assert.equal((await r.call("memory.capture", { text: "Another decision." })).isError, false);
  assert.equal(r.calls.captures.length, 2);
  for (const [index, capture] of r.calls.captures.entries()) {
    assert.equal(capture.agentId, "agent");
    assert.deepEqual(capture.caller, caller);
    assert.equal(capture.authenticatedPerson, "person");
    assert.equal(capture.sessionId, "session");
    assert.equal(capture.turnId, `turn:memory:${index + 1}`);
    assert.equal(capture.incognito, false);
    assert.equal(capture.messages[0]!.role, "assistant");
  }
  assert.equal(r.calls.captures[0]!.messages[0]!.content, "A decision to remember.");
});

it("memory writes use their own local-write capability and can require an explicit person approval", async () => {
  const r = rig({}, false, true);
  const result = await r.call("memory.capture", { text: "decision" });
  assert.equal(result.isError, true);
  if (result.isError) assert.equal(result.error.code, "tool-not-approved");
  assert.equal(r.approvals(), 1);
  assert.equal(r.calls.captures.length, 0);
  assert.equal(r.tools.find(tool => tool.name === "memory.capture")!.effect, "local-write");
  assert.equal(r.tools.find(tool => tool.name === "memory.capture")!.capability, "memory.write");
  assert.equal(CAPABILITIES.get("memory.write")!.minSurface, 2);
  const approved = rig({}, true, true);
  assert.equal((await approved.call("memory.capture", { text: "decision" })).isError, false);
  assert.equal(approved.calls.captures.length, 1);
});

it("rejects agent selectors and refuses a tool instance dispatched for another agent or session", async () => {
  const r = rig();
  const invalid = await r.call("memory.recall", { query: "other", agentId: "other" });
  assert.equal(invalid.isError, true);
  if (invalid.isError) assert.equal(invalid.error.code, "tool-call-invalid");
  for (const extra of [{ agentId: "other" }, { sessionId: "other" }]) {
    const result = await r.call("memory.recall", { query: "other" }, extra);
    assert.equal(result.isError, true);
    if (result.isError) assert.equal(result.error.sourceCode, "memory-scope-mismatch");
  }
  assert.equal(r.calls.recalls.length, 0);
});

it("incognito and reviewer read-only turns refuse capture while recall remains available", async () => {
  for (const over of [{ incognito: true }, { readOnlyWorktree: "/review" }]) {
    const r = rig(over);
    const result = await r.call("memory.capture", { text: "must not store" });
    assert.equal(result.isError, true);
    if (result.isError) assert.equal(result.error.sourceCode,
      "incognito" in over ? "memory-incognito" : "memory-read-only");
    assert.equal(r.calls.captures.length, 0);
    assert.equal((await r.call("memory.recall", { query: "read only" })).isError, false);
  }
});

it("missing caller identity returns a typed unavailable error without inventing a memory principal", async () => {
  const r = rig();
  const { caller: omitted, ...req } = r.req;
  void omitted;
  const memory: TurnMemory = {
    async recall() { assert.fail("missing caller must never reach recall"); },
    async capture() { assert.fail("missing caller must never reach capture"); },
    async checkpoint() {},
  };
  for (const tool of createMemoryTools(memory, req)) {
    await assert.rejects(tool.execute(tool.name === "memory.recall" ? { query: "x" } : { text: "x" }, {
      agentId: "agent", principal: "principal", sessionId: "session", signal: req.signal,
    }), { code: "memory-unavailable" });
  }
});

it("an already aborted request never reaches memory even when the dispatch signal is live", async () => {
  const stop = new AbortController();
  stop.abort(new Error("cancelled"));
  const r = rig({ signal: stop.signal });
  const live = new AbortController().signal;
  for (const name of ["memory.recall", "memory.capture"]) {
    const result = await r.call(name, name === "memory.recall" ? { query: "x" } : { text: "x" }, { signal: live });
    assert.equal(result.isError, true);
  }
  assert.equal(r.calls.recalls.length + r.calls.captures.length, 0);
});

it("the real memory port retains ALS identity and channel restrictions for explicit tool calls", async () => {
  const workspace = tempDir("n-memory-scope-");
  const engineRecalls: { principal: { user: string } }[] = [];
  const engineCaptures: { principal: { user: string } }[] = [];
  const logs: unknown[] = [];
  const logger: HarnessLogger = {
    debug() {}, warn() {}, error() {}, setLevel() {}, setRotation() {},
    info(...args) { logs.push(args); }, child() { return this; }, async close() {},
  };
  const port = engineTurnMemory({
    // Only this port's two engine-boundary methods execute in the fixture.
    engine: {
      async recall(args: { principal: { user: string } }) {
        engineRecalls.push(args);
        return { blocks: [], capChars: 1000, degraded: null };
      },
      capture(args: { principal: { user: string } }) {
        engineCaptures.push(args);
        return { id: "capture", done: Promise.resolve({ stored: 1, skipped: 0 }) };
      },
    } as never,
    config: defaults,
    agents: { list: () => ["agent"], has: () => true, scaffold: () => {}, workspaceOf: () => workspace },
    logger, captureSignal: new AbortController().signal, isStopping: () => false,
  });
  const req = rig().req;
  const tools = createMemoryTools(port, req);
  const ctx = { agentId: "agent", sessionId: "session", principal: "principal", signal: req.signal };
  const recall = tools.find(tool => tool.name === "memory.recall")!;
  const capture = tools.find(tool => tool.name === "memory.capture")!;
  await runWithAgentScope(scopeFor("agent", workspace), async () => {
    await recall.execute({ query: "relevant facts" }, ctx);
    await capture.execute({ text: "a fact" }, ctx);
  });
  assert.equal(engineRecalls[0]!.principal.user, deriveUserPrincipal("person"));
  assert.equal(engineCaptures[0]!.principal.user, deriveUserPrincipal("person"));
  await channelBehaviour.run(resolveBehaviour({}, { channel: "matrix", chatKind: "group" }).profile, async () => {
    const result = await recall.execute({ query: "private group body" }, ctx) as {
      degraded: { reason: string };
    };
    assert.equal(result.degraded.reason, "behaviour-scope-unavailable");
    await capture.execute({ text: "private group body" }, ctx);
  });
  assert.equal(engineRecalls.length, 1);
  assert.equal(engineCaptures.length, 1);
  assert.match(JSON.stringify(logs), /channel.capture.provenance/);
  assert.equal(JSON.stringify(logs).includes("private group body"), false);
});

it("N2/7: memory.capture says so when the port did not hand the text to the engine", async () => {
  const workspace = tempDir("n2-memory-submit-");
  const engineCaptures: unknown[] = [];
  let stopping = false;
  const logs: unknown[] = [];
  const logger: HarnessLogger = {
    debug() {}, warn(...args) { logs.push(args); }, error() {}, setLevel() {}, setRotation() {},
    info(...args) { logs.push(args); }, child() { return this; }, async close() {},
  };
  const port = engineTurnMemory({
    engine: { capture(args: unknown) { engineCaptures.push(args); return { id: "capture", done: Promise.resolve({ stored: 1, skipped: 0 }) }; } } as never,
    config: defaults,
    agents: { list: () => ["agent"], has: () => true, scaffold: () => {}, workspaceOf: () => workspace },
    logger, captureSignal: new AbortController().signal, isStopping: () => stopping,
  });
  const req = rig().req;
  const capture = createMemoryTools(port, req).find(tool => tool.name === "memory.capture")!;
  const ctx = { agentId: "agent", sessionId: "session", principal: "principal", signal: req.signal };
  const submit = (text: string) => runWithAgentScope(scopeFor("agent", workspace), () => capture.execute({ text }, ctx));
  const under = (set: Parameters<typeof resolveBehaviour>[0], context: Parameters<typeof resolveBehaviour>[1], text: string) =>
    channelBehaviour.run(resolveBehaviour(set, context).profile, () => submit(text));

  assert.deepEqual(await submit("a decision"), { submitted: true });
  assert.equal(engineCaptures.length, 1);
  const refusals = [
    ["channel policy none", await under({ default: { memory: { capture: "none" } } }, { channel: "cli", chatKind: "direct" }, "none body"), "channel-policy"],
    ["channel policy provenance-only", await under({}, { channel: "matrix", chatKind: "group" }, "group body"), "channel-policy"],
    ["scope not allowed", await under({ default: { memory: { allowedScopes: ["agent-private"] } } }, { channel: "cli", chatKind: "direct" }, "scope body"), "scope-not-permitted"],
  ] as const;
  stopping = true;
  const afterStop = await submit("late body");
  for (const [label, result, reason] of refusals) assert.deepEqual(result, { submitted: false, reason }, label);
  assert.deepEqual(afterStop, { submitted: false, reason: "core-stopping" });
  assert.equal(engineCaptures.length, 1, "none of the refused texts reached the engine");
  assert.doesNotMatch(JSON.stringify([refusals, afterStop]), /body|policy-/);
});
