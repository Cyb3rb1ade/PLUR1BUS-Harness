/** N-F2/F3: session offers only change at boundaries and retain admitted discovered tools. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LiveCapabilityIndex } from "../../src/toolcall/live-index.ts";
import { collect, readTool, scriptedAdapter, turnFixture, turnRequest, useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("n-stable-tools-");

it("queues a discovered non-core tool for the next turn while keeping this turn's declarations fixed", async () => {
  const home = tmp.make();
  mkdirSync(join(home, "state"));
  const live = new LiveCapabilityIndex(home);
  const wire = scriptedAdapter([
    { calls: [{ id: "find", name: "capabilities.search", args: { query: "uniquetarget" } }] },
    { text: "found" },
    { calls: [{ id: "use", name: "ops.zzztarget", args: { path: "x" } }] },
    { text: "done" },
  ]);
  const f = turnFixture(wire.adapter, { capabilities: live, topK: 1 }, home);
  f.registry.register(readTool("file.read", async () => "file", { description: "read file" }));
  for (let i = 0; i < 16; i++) f.registry.register(readTool(`ops.a${i}`, async () => "other"));
  let used = 0;
  f.registry.register(readTool("ops.zzztarget", async () => { used++; return "target"; },
    { description: "uniquetarget" }));
  const names = (index: number) => wire.requests[index]!.tools!.map(tool => tool.name);
  try {
    await collect(f.provider, turnRequest({ messages: [{ role: "user", text: "read file" }] }));
    assert.equal(names(0).includes("ops_zzztarget"), false);
    assert.deepEqual(names(0), names(1));
    await collect(f.provider, turnRequest({ turnId: "next", messages: [{ role: "user", text: "Hello!" }] }));
    assert.ok(names(2).includes("ops_zzztarget"));
    assert.ok(names(0).every(name => names(2).includes(name)));
    assert.equal(used, 1);
  } finally { live.close(); f.close(); }
});
