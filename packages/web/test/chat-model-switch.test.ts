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

test("per-chat model choice: load and set go to the chat routes with the shown revision; levels map to the nearest supported", async () => {
  const { loadChatModel, setChatModel, effectiveLevel, activeProfile } = await import("../src/pages/chat/model-switch.ts");
  const { directChatApi } = await import("../src/pages/chat/api.ts");
  const rest: unknown[][] = [];
  const base = { rpc: async () => { throw new Error("must not fall back to /rpc"); }, get: async (...a: unknown[]) => { rest.push(["GET", ...a]); return { sessionId: "s", profile: null, defaultProfile: "default", reasoning: "default", revision: 3, profiles: [] }; },
    post: async () => ({}), patch: async (...a: unknown[]) => { rest.push(["PATCH", ...a]); return { revision: 4 }; }, put: async () => ({}), delete: async () => ({}), events: () => ({}) } as unknown as Api;
  const api = directChatApi(base);
  const state = await loadChatModel(api, "s/1");
  assert.equal(rest[0]![1], "/api/v1/chats/s%2F1/model");
  assert.equal(activeProfile(state), "default");
  await setChatModel(api, { sessionId: "s/1", revision: 3 }, "deep", "high");
  assert.deepEqual(rest[1]!.slice(0, 3), ["PATCH", "/api/v1/chats/s%2F1/model", { profile: "deep", reasoning: "high", expectedRevision: 3 }]);
  assert.equal(effectiveLevel("xhigh", ["low", "medium", "high"]), "high");
  assert.equal(effectiveLevel("medium", ["low", "high"]), "low", "a tie goes to the cheaper level");
  assert.equal(effectiveLevel("high", []), "default", "a model without levels sends nothing");
  assert.equal(effectiveLevel("default", ["low"]), "default");
});
