/** N-A1: direct/background and session observers account for the same actual turn exactly once. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createTurnObserver } from "../../src/composition/turn-observer.ts";
import { createTurnTelemetry } from "../../src/session/turn-telemetry.ts";
import { collect, scriptedAdapter, turnFixture, turnRequest, useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("n-turn-observer-");

it("counts provider-direct headless turns and deduplicates their later persisted completion", async () => {
  let count = 0;
  const observe = createTurnObserver(() => count++);
  const wire = scriptedAdapter([{ text: "done" }]);
  const f = turnFixture(wire.adapter, { onTelemetry: (request, telemetry) => observe(telemetry,
    { sessionId: request.sessionId, turnId: request.turnId!, agentId: request.agentId }) }, tmp.make());
  const request = turnRequest({ headlessJobId: "job" });
  try {
    await collect(f.provider, request);
    assert.equal(count, 1);
    observe(createTurnTelemetry(), { sessionId: request.sessionId, turnId: request.turnId!, agentId: request.agentId });
    assert.equal(count, 1);
    await collect(f.provider, { ...request, turnId: "next" });
    assert.equal(count, 2);
    await collect(f.provider, { ...request, turnId: "role", role: "decision", messages: [] });
    assert.equal(count, 2);
  } finally { f.close(); }
});
