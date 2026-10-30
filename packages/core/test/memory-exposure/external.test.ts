// Shared external memory filtering must preserve token restrictions across turn adapters.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { defaults } from "@plur1bus/config-schema";
import { externalMemory } from "../../src/memory-exposure/external.ts";
import { MemorySensitivityService } from "../../src/memory-sensitivity/service.ts";
import { MemorySensitivityStore } from "../../src/memory-sensitivity/store.ts";
import type { TurnMemory } from "../../src/session/memory-port.ts";
import type { Principal } from "../../src/rbac/types.ts";

function fixture(t: TestContext) {
  const service = new MemorySensitivityService({ store: new MemorySensitivityStore({ path: ":memory:" }) });
  t.after(() => service.close());
  let currentService: MemorySensitivityService | null = null;
  const blocks = [
    { name: "identity", text: "HARMLESS-MARKER", droppable: false, chars: 15 },
    { name: "memories", text: "HEALTH-MARKER diabetes", droppable: true, chars: 22 },
  ];
  const captured: Parameters<TurnMemory["capture"]>[0][] = [];
  const memory: TurnMemory = {
    recall: async () => ({ text: blocks.map(b => b.text).join("\n"), blocks, degraded: null }),
    capture: async request => { captured.push(request); return { submitted: true }; },
    checkpoint: async () => {},
  };
  const adapter = externalMemory({ memory, config: defaults,
    logger: { info: () => {}, warn: () => {} }, sensitivity: () => currentService });
  const principal: Principal = { role: "owner", userId: "alice", kind: "agent", tokenId: "personal-token",
    binding: { audience: "mcp", agentId: "alpha", memory: { filter: ["health"] } } };
  const turn = { agentId: "alpha", channel: "mcp" as const, principal, sessionId: "test" };
  return { adapter, turn, captured, service, enable: () => { currentService = service; } };
}

test("external turn filter options cannot remove a token sensitivity filter", async t => {
  const f = fixture(t);
  f.enable();
  const result = await f.adapter.recall({ ...f.turn, filter: [] }, "facts");
  assert.match(result, /HARMLESS-MARKER/);
  assert.doesNotMatch(result, /HEALTH-MARKER|diabetes/);
});

test("external turn sensitivity filtering withholds text while its live service is unavailable", async t => {
  const f = fixture(t);
  assert.equal(await f.adapter.recall(f.turn, "facts"), "");
  f.enable();
  assert.match(await f.adapter.recall(f.turn, "facts"), /HARMLESS-MARKER/);
});


test("external turns cannot capture with an agent.use-only or read-only personal token", async t => {
  const f = fixture(t);
  for (const tokenScopes of [["agent.use"], ["memory.workspace.read"]]) {
    const principal = { ...f.turn.principal, tokenScopes };
    f.adapter.capture({ ...f.turn, principal, turnId: "turn" }, { question: "question", answer: "answer" });
    await f.adapter.idle();
  }
  assert.equal(f.captured.length, 0);
});

test("external turns capture with explicit personal-token write authorization but never a true agent", async t => {
  const f = fixture(t);
  const principal = { ...f.turn.principal, tokenScopes: ["memory.workspace.write"] };
  f.adapter.capture({ ...f.turn, principal, turnId: "turn" }, { question: "question", answer: "answer" });
  await f.adapter.idle();
  assert.equal(f.captured.length, 1);
  const { tokenId: _omit, ...agent } = principal;
  f.adapter.capture({ ...f.turn, principal: agent, turnId: "agent-turn" }, { question: "question", answer: "answer" });
  await f.adapter.idle();
  assert.equal(f.captured.length, 1);
});


test("external turn aggregates are withheld while any matching manual sensitivity label exists", async t => {
  const f = fixture(t);
  f.enable();
  f.service.setSensitivity("different-card-id", ["health"]);
  assert.equal(await f.adapter.recall(f.turn, "facts"), "");
  f.service.clearSensitivity("different-card-id", "health");
  assert.match(await f.adapter.recall(f.turn, "facts"), /HARMLESS-MARKER/);
});
