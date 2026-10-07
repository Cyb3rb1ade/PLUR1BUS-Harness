import { it } from "node:test";
import assert from "node:assert/strict";
import { createSink } from "../../src/logs/sink.ts";
import { logsDir } from "./helpers.ts";
it("secures each new file identity once, including after rotation", () => {
  const dir = logsDir(); const calls: string[] = [];
  const sink = createSink({ dir, role: "core", now: Date.now, securePath: p => { calls.push(p); return { applied: true }; } });
  sink.append("x\n"); sink.append("y\n");
  assert.equal(calls.filter(p => p === sink.file).length, 1);
  sink.setRotation({ maxBytes: 3, keep: 2 }); sink.append("z\n");
  assert.equal(calls.filter(p => p === sink.file).length, 2);
});
