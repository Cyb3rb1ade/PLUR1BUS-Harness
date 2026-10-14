import { it } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker } from "../src/activity.ts";

it("pages visible transitions, binds cursors to filters and rejects evicted cursors", () => {
  let now = 1000;
  const tracker = new ActivityTracker(() => now++, () => 3);
  tracker.set("a", { state: "recalling" });
  tracker.set("b", { state: "capturing" });
  tracker.idle("a");
  const first = tracker.list({ limit: 1 }, ["a"]);
  assert.deepEqual(first.items.map(i => i.agentId), ["a"]);
  assert.ok(first.nextCursor);
  assert.equal(tracker.list({ cursor: first.nextCursor! }, ["a"]).items[0]?.activity.state, "recalling");
  assert.throws(() => tracker.list({ cursor: first.nextCursor!, agentId: "b" }, ["a"]), /cursor/);
  tracker.set("a", { state: "capturing" });
  tracker.idle("a");
  tracker.set("a", { state: "dreaming" });
  assert.throws(() => tracker.list({ cursor: first.nextCursor! }, ["a"]), /cursor/);
});
