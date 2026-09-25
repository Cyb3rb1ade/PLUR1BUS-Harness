import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker } from "../src/activity.ts";

describe("ActivityTracker", () => {
  it("starts idle, emits on every transition, keeps since", () => {
    let now = 1000; const t = new ActivityTracker(() => now);
    const seen: unknown[] = []; t.onChange((id, a) => seen.push([id, a]));
    assert.deepEqual(t.get("bernd"), { state: "idle", since: 1000 });
    now = 1010; t.set("bernd", { state: "recalling" });
    now = 1020; t.set("bernd", { state: "dreaming", phase: "rem", job: "rem-dream" });
    now = 1030; t.idle("bernd");
    assert.deepEqual(seen, [["bernd", { state: "recalling", since: 1010 }], ["bernd", { state: "dreaming", phase: "rem", job: "rem-dream", since: 1020 }], ["bernd", { state: "idle", since: 1030 }]]);
  });
  it("setting the same state again does not emit", () => {
    const t = new ActivityTracker(() => 1); let n = 0; t.onChange(() => n++);
    t.set("a", { state: "capturing" }); t.set("a", { state: "capturing" });
    assert.equal(n, 1);
  });
});
