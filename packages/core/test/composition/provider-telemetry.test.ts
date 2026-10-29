/** N-A1: the real provider emits one bounded final usage snapshot on success and failure. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { collect, readTool, scriptedAdapter, turnFixture, turnRequest, useTempDirs } from "./helpers.ts";
import type { ChatChunk } from "../../src/session/provider.ts";

const tmp = useTempDirs("n-provider-telemetry-");

it("reports model rounds and executed tools in one final telemetry chunk", async () => {
  const wire = scriptedAdapter([{ calls: [{ id: "one", name: "file.read", args: { path: "x" } }] }, { text: "done" }]);
  const f = turnFixture(wire.adapter, {}, tmp.make());
  f.registry.register(readTool("file.read", async () => "contents"));
  try {
    const chunks = await collect(f.provider);
    const observations = chunks.filter(c => c.type === "telemetry");
    assert.equal(observations.length, 1);
    assert.equal(chunks.at(-1)?.type, "telemetry");
    assert.equal(observations[0]?.telemetry.rounds, 2);
    assert.equal(observations[0]?.telemetry.toolCalls, 1);
    assert.equal(observations[0]?.telemetry.endReason, "completed");
    assert.ok((observations[0]?.telemetry.triageDurationMs ?? -1) >= 0);
  } finally { f.close(); }
});

it("reports an early provider admission failure without dropping its typed error", async () => {
  const wire = scriptedAdapter([{ text: "never" }]);
  const f = turnFixture(wire.adapter, { profile: "missing" }, tmp.make());
  const chunks: ChatChunk[] = [];
  try {
    await assert.rejects(async () => {
      for await (const chunk of f.provider.stream(turnRequest())) chunks.push(chunk);
    }, { code: "unknown_profile" });
    const last = chunks.at(-1);
    assert.equal(last?.type, "telemetry");
    if (last?.type === "telemetry") {
      assert.equal(last.telemetry.rounds, 0);
      assert.equal(last.telemetry.endReason, "provider-error");
    }
  } finally { f.close(); }
});
