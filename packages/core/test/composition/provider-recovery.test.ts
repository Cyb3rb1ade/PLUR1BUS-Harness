/** N-B1/B2: failed tool calls cost a round and remain paired, safe model inputs. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { collect, readTool, scriptedAdapter, turnFixture, turnRequest, useTempDirs } from "./helpers.ts";
import type { ChatChunk } from "../../src/session/provider.ts";

const tmp = useTempDirs("n-recovery-");
const call = (id: string, name: string) => ({ id, name, args: { path: "x" } });

it("returns an unknown tool with offered names and search hint, then lets the model recover", async () => {
  const wire = scriptedAdapter([{ calls: [call("one", "missing.tool")] }, { text: "recovered" }]);
  const f = turnFixture(wire.adapter, {}, tmp.make());
  f.registry.register(readTool("file.read", async () => "unused"));
  try {
    const chunks = await collect(f.provider);
    assert.equal(wire.requests.length, 2);
    const message = wire.requests[1]?.messages.find(m => m.role === "tool");
    assert.ok(message && message.role === "tool");
    const output = JSON.parse(message.content);
    assert.equal(output.error.code, "tool-unknown");
    assert.match(output.error.message, /file.read/);
    assert.match(output.error.hint, /capabilities.search/);
    assert.ok(chunks.some(c => c.type === "delta" && c.text.includes("recovered")));
  } finally { f.close(); }
});

it("redacts and returns a thrown tool exception before a successful second model round", async () => {
  const wire = scriptedAdapter([{ calls: [call("one", "file.read")] }, { text: "recovered" }]);
  const f = turnFixture(wire.adapter, { secrets: () => ["secret-probe"] }, tmp.make());
  f.registry.register(readTool("file.read", async () => {
    throw Object.assign(new Error("missing /home/alice/project/report.txt secret-probe\n    at private"), { code: "file_missing" });
  }));
  try {
    const chunks = await collect(f.provider);
    const result = chunks.find(c => c.type === "tool.result");
    assert.ok(result && result.type === "tool.result");
    assert.doesNotMatch(result.output, /alice|secret-probe|    at /);
    const output = JSON.parse(result.output);
    assert.equal(output.error.code, "tool-failed");
    assert.equal(output.error.sourceCode, "file_missing");
    assert.ok(output.error.message.length <= 300);
    const observed = chunks.find(c => c.type === "telemetry");
    assert.equal(observed?.type === "telemetry" && observed.telemetry.errorsReturned, 1);
    assert.equal(wire.requests.length, 2);
  } finally { f.close(); }
});

it("returns three consecutive failures before stopping with an explicit limit reason", async () => {
  const wire = scriptedAdapter([{ calls: [call("one", "file.read")] }]);
  const f = turnFixture(wire.adapter, {}, tmp.make());
  f.registry.register(readTool("file.read", async () => { throw new Error("missing"); }));
  const chunks: ChatChunk[] = [];
  try {
    await assert.rejects(async () => {
      for await (const chunk of f.provider.stream(turnRequest())) chunks.push(chunk);
    }, { code: "turn-tool-error-limit" });
    assert.equal(wire.requests.length, 3);
    assert.equal(chunks.filter(c => c.type === "tool.result").length, 3);
    const final = chunks.at(-1);
    assert.equal(final?.type === "telemetry" && final.telemetry.endReason, "error-limit");
  } finally { f.close(); }
});
