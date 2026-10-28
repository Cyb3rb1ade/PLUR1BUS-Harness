// N-A1: telemetry is additive to completion/failure and cannot change the turn outcome.
import assert from "node:assert/strict";
import { it } from "node:test";
import { Compactor } from "../../src/session/compaction.ts";
import type { ChatProvider } from "../../src/session/provider.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import { openSessionService } from "../../src/session/service.ts";
import type { HarnessLogger } from "../../src/logger.ts";

function rig(provider: ChatProvider, onTurnTelemetry?: (telemetry: unknown) => void) {
  const store = new SessionStore({ path: ":memory:" });
  const runner = new TurnRunner({
    store,
    compactor: new Compactor(store),
    memory: {
      async recall() { return { text: "", degraded: null }; },
      async capture() {},
      async checkpoint() {},
    },
    provider: () => provider,
    ...(onTurnTelemetry ? { onTurnTelemetry } : {}),
  });
  const session = store.createSession({ kind: "direct", agentId: "fixture", owner: "user:v1:fixture" });
  const submit = () => runner.submit({
    session,
    caller: { channel: "cli", accountId: "fixture", userId: "fixture" },
    text: "hello",
  }).done;
  return { store, runner, session, submit };
}

const snapshot = () => ({
  rounds: 3,
  toolCalls: 2,
  metaCalls: { search: 1, skillLoad: 1, skillRead: 1 },
  skills: { injected: 1, loaded: 2 },
  toolChoice: { status: "required" as const, forced: true },
  toolNeed: { detected: true, reasons: ["path" as const] },
  errorsReturned: 1,
  endReason: "completed" as const,
  triageDurationMs: 25,
});

it("stores provider telemetry alongside token usage and reports it once after completion", async () => {
  const seen: unknown[] = [];
  const r = rig({
    id: "fixture",
    async *stream() {
      yield { type: "delta", text: "answer" };
      yield { type: "usage", inputTokens: 10, outputTokens: 2 };
      yield { type: "telemetry", telemetry: snapshot() };
    },
  }, telemetry => seen.push(telemetry));
  assert.equal((await r.submit()).state, "completed");
  const event = r.store.listEvents(r.session.id).at(-1)!;
  assert.deepEqual(event.data.telemetry, snapshot());
  assert.deepEqual(event.data.usage, { inputTokens: 10, outputTokens: 2 });
  assert.deepEqual(seen, [snapshot()]);
  await r.runner.idle();
  r.store.close();
});

it("counts real and meta calls for providers without telemetry without changing their reply", async () => {
  const r = rig({
    id: "fixture",
    async *stream() {
      for (const name of ["file.read", "capabilities.search", "skill.load", "skill.read"]) {
        yield { type: "tool.call", id: name, name, args: {} };
        yield { type: "tool.result", id: name, output: "ok" };
      }
      yield { type: "delta", text: "unchanged" };
    },
  });
  assert.equal((await r.submit()).reply, "unchanged");
  const telemetry = r.store.listEvents(r.session.id).at(-1)!.data.telemetry as ReturnType<typeof snapshot>;
  assert.equal(telemetry.rounds, 1);
  assert.equal(telemetry.toolCalls, 1);
  assert.deepEqual(telemetry.metaCalls, { search: 1, skillLoad: 1, skillRead: 1 });
  assert.equal(telemetry.endReason, "completed");
  await r.runner.idle();
  r.store.close();
});

it("keeps the final telemetry on a failed turn and reports the failure once", async () => {
  const seen: unknown[] = [];
  const telemetry = { ...snapshot(), endReason: "budget" as const };
  const r = rig({
    id: "fixture",
    async *stream() {
      yield { type: "telemetry", telemetry };
      throw Object.assign(new Error("budget limit"), { code: "budget-exceeded" });
    },
  }, sample => seen.push(sample));
  assert.equal((await r.submit()).state, "failed");
  const event = r.store.listEvents(r.session.id).at(-1)!;
  assert.equal(event.type, "turn.failed");
  assert.deepEqual(event.data.telemetry, telemetry);
  assert.deepEqual(seen, [telemetry]);
  r.store.close();
});

it("a telemetry observer failure cannot turn a completed answer into a failed turn", async () => {
  const r = rig({ id: "fixture", async *stream() { yield { type: "delta", text: "ok" }; } }, () => {
    throw new Error("metrics unavailable");
  });
  assert.equal((await r.submit()).state, "completed");
  assert.equal(r.store.listEvents(r.session.id).at(-1)!.type, "turn.completed");
  await r.runner.idle();
  r.store.close();
});

it("session services forward telemetry from persistent and ephemeral runners to the same observer", async () => {
  const seen: unknown[] = [];
  const logger: HarnessLogger = {
    debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, setRotation() {},
    child() { return this; }, async close() {},
  };
  const service = openSessionService({
    dbPath: ":memory:", clock: () => 1000, logger,
    agents: { list: () => ["fixture"], has: () => true, scaffold: () => {}, workspaceOf: () => "/fixture" },
    isStopping: () => false,
    memory: {
      async recall() { return { text: "", degraded: null }; },
      async capture() {},
      async checkpoint() {},
    },
    provider: () => ({ id: "fixture", async *stream() { yield { type: "delta", text: "ok" }; } }),
    notify: () => {}, signal: new AbortController().signal,
    onTurnTelemetry: telemetry => seen.push(telemetry),
  });
  try {
    for (const target of [service, service.ephemeral()]) {
      const session = target.store.createSession({ kind: "direct", agentId: "fixture", owner: "user:v1:fixture" });
      const result = await target.runner.submit({
        session, caller: { channel: "cli", accountId: "fixture", userId: "fixture" }, text: "hello",
      }).done;
      assert.equal(result.state, "completed");
    }
    assert.equal(seen.length, 2);
  } finally {
    await service.close();
  }
});
