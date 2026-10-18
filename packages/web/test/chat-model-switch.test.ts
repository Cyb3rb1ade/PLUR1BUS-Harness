import assert from "node:assert/strict";
import test from "node:test";
import type { Api } from "../src/api/index.ts";
import { confirmModelSwitch, previewModelSwitch, type ModelSwitchPreview } from "../src/pages/chat/model-switch.ts";
test("chat model switch sends an unconfirmed preview, then confirms precisely that profile and revision", async () => {
  const calls: any[] = [];
  const preview: ModelSwitchPreview = { sessionId: "s", profile: "second", previousProfile: "first", revision: 8, applied: false, warning: "cache-rebuild-cost-prefixes-preserved" };
  const api = { rpc: async (...args: any[]) => { calls.push(args); return preview; } } as unknown as Api;
  const shown = await previewModelSwitch(api, "s", "second");
  assert.equal(calls.length, 1); assert.deepEqual(calls[0][1], { sessionId: "s", profile: "second" });
  await confirmModelSwitch(api, shown);
  assert.deepEqual(calls[1][1], { sessionId: "s", profile: "second", confirmed: true, expectedRevision: 8 });
  assert.equal(calls[1][2].write, true);
});
