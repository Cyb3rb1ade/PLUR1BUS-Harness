// A turn loop that executes tool calls through the dispatcher stores the dispatcher's envelope as the transcript row of the
// call: with a registry, that envelope already holds the redacted value.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import type { TurnMemory } from "../../src/session/memory-port.ts";
import type { ChatChunk, ChatProvider, ChatRequest } from "../../src/session/provider.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const CALLER = { channel: "cli" as const, accountId: "acc", userId: "u" };
const memory: TurnMemory = { async recall() { return { text: "", degraded: null }; }, async capture() {}, async checkpoint() {} };
const fakeSecret = (label: string): string => `fixture-${label}-${createHash("sha256").update(label).digest("hex").slice(0, 16)}`;
const MARK = "[REDACTED:secret]";

class ScriptedProvider implements ChatProvider {
  readonly id = "scripted"; readonly chunks: ChatChunk[];
  constructor(chunks: ChatChunk[]) { this.chunks = chunks; }
  async *stream(_req: ChatRequest): AsyncGenerator<ChatChunk> { for (const c of this.chunks) yield c; }
}

describe("turn loop with a dispatcher: the transcript row of a successful call", () => {
  it("is redacted against the registry the dispatcher was given", async () => {
    const secret = fakeSecret("b1");
    const store = new SessionStore({ path: ":memory:" });
    const registry = new ToolRegistry();
    registry.register({ name: "demo.echo", description: "echo", capability: "sys.read", effect: "read", risk: "low", trust: "operator-vetted",
      inputSchema: { type: "object", additionalProperties: false, properties: {} }, execute: async () => ({ stdout: `KEY=${secret}` }) });
    const dispatcher = new ToolDispatcher({ registry, grants: { list: () => [], get: () => undefined }, clock: { now: () => Date.now() },
      approvals: { request: async () => ({ approved: false }) }, secrets: () => [secret] });
    const provider = new ScriptedProvider([{ type: "tool.call", id: "t1", name: "demo.echo", args: {} }, { type: "delta", text: "done" }]);
    const compactor = new Compactor(store, defaultCompaction(8192), { beforeSwap: async () => {} });
    const runner = new TurnRunner({ store, compactor, memory, provider: () => provider,
      toolCalls: { dispatcher, context: ({ session }) => ({ agentId: session.agentId, principal: session.owner, sessionId: session.id, surface: 3 }) } });
    const session = store.createSession({ kind: "direct", agentId: "bernd", owner: "user:v1:o", memoryMode: "remember" });
    const out = await runner.submit({ session, caller: CALLER, text: "go" }).done;
    await runner.idle();
    assert.equal(out.state, "completed");
    const events = store.listEvents(session.id);
    const row = events.find((e) => e.type === "tool.result")!;
    const envelope = JSON.parse(row.data.output as string) as { isError: boolean; value: unknown };
    assert.deepEqual(envelope.value, { stdout: `KEY=${MARK}` });
    assert.ok(!JSON.stringify(events).includes(secret), "no stored event holds the value");
  });
});
