// The shell's document listeners are removed by their disposers (no leak across sign-out/remount or repeated binds).
import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as Record<string, unknown>;
const added = new Map<string, Set<unknown>>();
g.document = {
  addEventListener: (t: string, fn: unknown) => { (added.get(t) ?? added.set(t, new Set()).get(t)!).add(fn); },
  removeEventListener: (t: string, fn: unknown) => { added.get(t)?.delete(fn); },
};

test("bindPalette's disposer removes the keydown listener it added", async () => {
  const { bindPalette } = await import("../src/palette/hotkey.ts");
  const off = bindPalette();
  assert.equal(added.get("keydown")?.size, 1);
  off();
  assert.equal(added.get("keydown")?.size ?? 0, 0);
});
