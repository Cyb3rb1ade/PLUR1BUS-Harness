/** Final review regressions: preload ownership, transactional history, paired cancellation and iterator cleanup. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderError, type StreamingAdapter } from "../../../providers/src/index.ts";
import { LiveCapabilityIndex } from "../../src/toolcall/live-index.ts";
import type { TurnProviderOptions } from "../../src/composition/provider.ts";
import { SessionStore } from "../../src/session/store.ts";
import { Compactor } from "../../src/session/compaction.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import { createTurnObserver } from "../../src/composition/turn-observer.ts";
import { collect, readTool, scriptedAdapter, TURN_PRINCIPAL, turnFixture, turnRequest, useTempDirs } from "./helpers.ts";
import type { ChatChunk } from "../../src/session/provider.ts";

const tmp = useTempDirs("n-review-regression-");

function skills(names: string[], adapter: StreamingAdapter, options: Partial<TurnProviderOptions> = {}) {
  const home = tmp.make();
  mkdirSync(join(home, "state"));
  for (const name of names) {
    mkdirSync(join(home, "skills", name), { recursive: true });
    writeFileSync(join(home, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Create reports\n---\nBODY:${name}`);
  }
  writeFileSync(join(home, "skills", "index.json"), JSON.stringify({ version: 1,
    skills: names.map(id => ({ id, enabled: true })) }));
  const live = new LiveCapabilityIndex(home);
  const fixture = turnFixture(adapter, { capabilities: live, skillsForAgent: () => ({ pinned: names }), ...options }, home);
  return { ...fixture, home, live, close() { live.close(); fixture.close(); } };
}

it("opens lazy permissions before dispatching the first harness skill load", async () => {
  let opened = false;
  const wire = scriptedAdapter([{ text: "done" }]);
  const f = skills(["reports"], wire.adapter, {
    beforeTools: async () => { opened = true; },
    policyContext: () => { if (!opened) throw new Error("permissions not open"); return {}; },
  });
  try {
    const chunks = await collect(f.provider);
    assert.equal(opened, true);
    const result = chunks.find(chunk => chunk.type === "tool.result");
    assert.ok(result && result.type === "tool.result");
    assert.equal(JSON.parse(result.output).isError, false);
    assert.equal(wire.requests.length, 1);
  } finally { f.close(); }
});

it("does not reuse successful skill loads from an otherwise failed turn", async () => {
  let calls = 0;
  const wire = scriptedAdapter([{ text: "done" }]);
  const adapter: StreamingAdapter = { async *stream(request, options) {
    if (++calls === 1) throw new ProviderError("invalid_request", "fixture refusal");
    yield* wire.adapter.stream(request, options);
  } };
  const f = skills(["reports"], adapter, { restoreSkills: () => ({ selected: [], loaded: [] }) });
  try {
    await assert.rejects(() => collect(f.provider));
    const next = await collect(f.provider, turnRequest({ turnId: "second" }));
    assert.equal(next.filter(chunk => chunk.type === "tool.call" && chunk.name === "skill.load").length, 1);
    assert.equal(f.live.registry.stats("skill:reports", "a1").used, 2);
  } finally { f.close(); }
});

it("a successful preload resets the consecutive error limit before model calls", async () => {
  let opened = 0;
  const wire = scriptedAdapter([
    { calls: [{ id: "read", name: "file.read", args: { path: "x" } }] }, { text: "recovered" },
  ]);
  const names = ["bad-first", "good-middle", "bad-last"];
  const f = skills(names, wire.adapter, { beforeTools: async () => {
    if (++opened === 1) for (const name of [names[0]!, names[2]!]) {
      unlinkSync(join(f.home, "skills", name, "SKILL.md"));
    }
  } });
  f.registry.register(readTool("file.read", async () => { throw new Error("missing"); }));
  try {
    const chunks = await collect(f.provider);
    const final = chunks.at(-1);
    assert.equal(final?.type === "telemetry" && final.telemetry.errorsReturned, 3);
    assert.equal(final?.type === "telemetry" && final.telemetry.endReason, "completed");
    assert.equal(wire.requests.length, 2);
  } finally { f.close(); }
});

it("a preload requiring a person stops immediately with its paired safe refusal", async () => {
  const wire = scriptedAdapter([{ text: "must not start" }]);
  const f = skills(["reports"], wire.adapter, {
    policyContext: () => ({ overrides: { "fs.read": "approval" } }),
  });
  const chunks: ChatChunk[] = [];
  try {
    await assert.rejects(async () => {
      for await (const chunk of f.provider.stream(turnRequest({ approver: { person: null, surface: 2 } }))) {
        chunks.push(chunk);
      }
    }, { code: "approval-requires-person" });
    assert.equal(wire.requests.length, 0);
    assert.equal(chunks.filter(chunk => chunk.type === "tool.call").length, 1);
    assert.equal(chunks.filter(chunk => chunk.type === "tool.result").length, 1);
  } finally { f.close(); }
});

it("persists the aborted tool result and observes the session's final cancelled outcome once", async () => {
  const outcomes: string[] = [];
  const observe = createTurnObserver(telemetry => outcomes.push(telemetry.endReason));
  const wire = scriptedAdapter([{ calls: [{ id: "read", name: "file.read", args: { path: "x" } }] }]);
  const f = turnFixture(wire.adapter, { onTelemetry: (request, telemetry) => observe(telemetry, {
    sessionId: request.sessionId, turnId: request.turnId!, agentId: request.agentId,
  }) }, tmp.make());
  const store = new SessionStore({ path: ":memory:" });
  const session = store.createSession({ kind: "direct", agentId: "a1", owner: TURN_PRINCIPAL });
  const runner = new TurnRunner({ store, compactor: new Compactor(store), provider: () => f.provider,
    onTurnTelemetry: observe, memory: {
      async recall() { return { text: "", degraded: null }; }, async capture() {}, async checkpoint() {},
    } });
  f.registry.register(readTool("file.read", async () => { runner.cancel(session.id); return "cancelled"; }));
  try {
    const handle = runner.submit({ session, caller: { channel: "cli", accountId: "a", userId: "u" }, text: "Read ./x" });
    const result = await handle.done;
    assert.equal(result.error, "cancelled");
    const events = store.listEvents(session.id);
    assert.equal(events.filter(event => event.type === "tool.call").length, 1);
    const results = events.filter(event => event.type === "tool.result");
    assert.equal(results.length, 1);
    assert.equal(JSON.parse(String(results[0]!.data.output)).error.code, "aborted");
    assert.deepEqual(outcomes, ["cancelled"]);
    assert.equal(wire.requests.length, 1);
  } finally { await runner.idle(); store.close(); f.close(); }
});

it("iterator return closes the adapter and reports cancellation without yielding another chunk", async () => {
  let closed = false;
  const outcomes: string[] = [];
  const wire = scriptedAdapter([{ text: "partial" }]);
  const adapter: StreamingAdapter = { async *stream(request, options) {
    try { yield* wire.adapter.stream(request, options); } finally { closed = true; }
  } };
  const f = turnFixture(adapter, { onTelemetry: (_request, telemetry) => outcomes.push(telemetry.endReason) }, tmp.make());
  try {
    const iterator = f.provider.stream(turnRequest())[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "delta");
    const result = await iterator.return!(undefined);
    assert.equal(result.done, true);
    assert.equal(closed, true);
    assert.deepEqual(outcomes, ["cancelled"]);
  } finally { f.close(); }
});

it("N2/6: failed preloads do not count toward the model's error limit; the model runs and sees them", async () => {
  const wire = scriptedAdapter([{ text: "I could not load the skills." }]);
  const names = ["broken-a", "broken-b", "broken-c"];
  let opened = 0;
  const f = skills(names, wire.adapter, { beforeTools: async () => {
    if (++opened === 1) for (const name of names) unlinkSync(join(f.home, "skills", name, "SKILL.md"));
  } });
  try {
    const chunks = await collect(f.provider);
    const results = chunks.filter(chunk => chunk.type === "tool.result");
    assert.equal(results.length, 3);
    for (const result of results) assert.equal(JSON.parse(result.output).isError, true);
    // The model was asked, once, and the three failures are in front of it as paired tool results.
    assert.equal(wire.requests.length, 1);
    const seen = wire.requests[0]!.messages.filter(message => message.role === "tool");
    assert.equal(seen.length, 3);
    assert.ok(seen.every(message => JSON.parse(String(message.content)).isError === true));
    const final = chunks.at(-1);
    assert.equal(final?.type === "telemetry" && final.telemetry.endReason, "completed");
    assert.equal(final?.type === "telemetry" && final.telemetry.errorsReturned, 3);
  } finally { f.close(); }
});

it("N2/6: the model's own error limit still counts after failed preloads", async () => {
  const wire = scriptedAdapter([{ calls: [{ id: "read", name: "file.read", args: { path: "x" } }] }]);
  const names = ["broken-a", "broken-b"];
  let opened = 0;
  const f = skills(names, wire.adapter, { beforeTools: async () => {
    if (++opened === 1) for (const name of names) unlinkSync(join(f.home, "skills", name, "SKILL.md"));
  } });
  f.registry.register(readTool("file.read", async () => { throw new Error("missing"); }));
  try {
    await assert.rejects(() => collect(f.provider), { code: "turn-tool-error-limit" });
    // Three failed model calls, not five failures in all: the two preloads did not count.
    assert.equal(wire.requests.length, 3);
  } finally { f.close(); }
});
