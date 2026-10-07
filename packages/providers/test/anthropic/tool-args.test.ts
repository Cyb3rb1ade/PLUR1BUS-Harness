import assert from "node:assert/strict";
import { test } from "node:test";
import { finaliseToolCall } from "../../src/anthropic/tool-args.ts";
import type { ToolArgumentRepair } from "../../src/index.ts";

const SIG = new AbortController().signal;
const call = (raw: string, repair?: ToolArgumentRepair, signal: AbortSignal = SIG) => finaliseToolCall("c", "f", raw, repair, [{ name: "f" }], signal);

test("valid, empty and non-object arguments", async () => {
  assert.deepEqual(await call("{\"a\":1}"), { id: "c", name: "f", argumentsRaw: "{\"a\":1}", arguments: { a: 1 } });
  assert.deepEqual((await call("")).arguments, {});
  const arr = await call("[1]");
  assert.equal(arr.arguments, undefined);
  assert.match(arr.argumentsError ?? "", /must be a JSON object/);
  assert.match((await call("{\"a\":")).argumentsError ?? "", /not valid JSON/);
});

test("a repair hook that throws, declines or answers badly never loses the turn", async () => {
  const bad = "{\"a\":";
  for (const repair of [
    { repair: () => { throw new Error("hook broke"); } }, { repair: () => undefined }, { repair: () => ({ arguments: [1] as never }) },
    { repair: () => ({ argumentsRaw: "{still broken" }) },
  ] as ToolArgumentRepair[]) {
    const c = await call(bad, repair);
    assert.equal(c.arguments, undefined);
    assert.ok(c.argumentsError);
    assert.equal(c.repaired, undefined);
  }
});

test("the hook gets the tool definition and the error; a good answer is marked repaired; an abort during repair propagates", async () => {
  let seen: unknown;
  const ok = await call("{\"a\":", { repair: (i) => { seen = i; return { argumentsRaw: "{\"a\":2}" }; } });
  assert.deepEqual(ok, { id: "c", name: "f", argumentsRaw: "{\"a\":2}", arguments: { a: 2 }, repaired: true });
  assert.equal((seen as { tool?: { name: string } }).tool?.name, "f");
  const ctl = new AbortController();
  await assert.rejects(call("{\"a\":", { repair: () => { ctl.abort(); throw new Error("stopped"); } }, ctl.signal), /stopped/);
});
