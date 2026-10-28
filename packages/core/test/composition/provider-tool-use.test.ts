/** N-E4/E5/E6: force tools at the real candidate boundary, with provider and delivery exceptions. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { collect, readTool, scriptedAdapter, turnFixture, turnRequest, useTempDirs } from "./helpers.ts";
import type { ProviderFamily } from "../../src/toolcall/quirks.ts";

const tmp = useTempDirs("n-provider-choice-");

for (const family of ["openai-chat", "openai-responses", "anthropic", "gemini"] as ProviderFamily[]) {
  it(`${family} forces a needed first round and restores auto after the model calls a tool`, async () => {
    const wire = scriptedAdapter([
      { calls: [{ id: "read", name: "file.read", args: { path: "x" } }] }, { text: "done" },
    ]);
    const f = turnFixture(wire.adapter, { family: { fixture: family } }, tmp.make());
    f.registry.register(readTool("file.read", async () => "contents"));
    try {
      const chunks = await collect(f.provider, turnRequest({ messages: [{ role: "user", text: "Read ./x" }] }));
      assert.equal(wire.requests[0]?.toolChoice, "required");
      assert.equal(wire.requests[1]?.toolChoice, "auto");
      const final = chunks.at(-1);
      assert.equal(final?.type === "telemetry" && final.telemetry.toolChoice.forced, true);
    } finally { f.close(); }
  });
}

it("plain chat and an explicit auto override keep automatic choice", async () => {
  const wire = scriptedAdapter([{ text: "hello" }]);
  const f = turnFixture(wire.adapter, {}, tmp.make());
  f.registry.register(readTool("file.read", async () => "unused"));
  try {
    await collect(f.provider, turnRequest({ messages: [{ role: "user", text: "Hello!" }] }));
    await collect(f.provider, turnRequest({ toolUseMode: "auto", messages: [{ role: "user", text: "Read ./x" }] }));
    assert.deepEqual(wire.requests.map(r => r.toolChoice), ["auto", "auto"]);
  } finally { f.close(); }
});
