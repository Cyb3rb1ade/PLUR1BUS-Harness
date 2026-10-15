import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker } from "../src/activity.ts";

/** Everything the tracker still holds for `visible`, read through the public paging API. */
function retained(t: ActivityTracker, visible: string[]): number {
  let n = 0; let cursor: string | undefined;
  do {
    const page = t.list({ limit: 200, ...(cursor ? { cursor } : {}) }, visible);
    n += page.items.length; cursor = page.nextCursor;
  } while (cursor);
  return n;
}
function churn(t: ActivityTracker, transitions: number) {
  for (let i = 0; i < transitions; i++) t.set("a", { state: i % 2 ? "capturing" : "recalling" });
}

describe("ActivityTracker history bound", () => {
  for (const [label, capacity, expected] of [
    ["NaN", NaN, 1000], ["Infinity", Infinity, 1000], ["a negative number", -5, 0], ["a fraction", 2.5, 2], ["zero", 0, 0], ["a normal value", 300, 300],
  ] as const) {
    it(`capacity ${label} keeps the history bounded (${expected})`, () => {
      let now = 0; const t = new ActivityTracker(() => now++, () => capacity);
      churn(t, 1500);
      assert.equal(retained(t, ["a"]), expected);
    });
  }
});

describe("ActivityTracker per-agent state bound", () => {
  it("does not keep one entry per agent id ever seen once they are idle", () => {
    let now = 0; const t = new ActivityTracker(() => now++, () => 200);
    t.set("first", { state: "recalling" }); t.idle("first");
    const idleSince = t.get("first").since;
    assert.equal(t.get("first").since, idleSince, "an idle agent within the bound keeps its idle timestamp");
    for (let i = 0; i < 1000; i++) { t.set(`agent-${i}`, { state: "recalling" }); t.idle(`agent-${i}`); }
    assert.notEqual(t.get("first").since, idleSince, "the oldest idle entries were evicted: get() answers a fresh idle");
    assert.equal(t.get("first").state, "idle");
    t.set("busy", { state: "dreaming", job: "j" });
    for (let i = 0; i < 1000; i++) { t.set(`other-${i}`, { state: "recalling" }); t.idle(`other-${i}`); }
    assert.equal(t.get("busy").state, "dreaming", "an agent that is not idle is never evicted");
  });
});

describe("ActivityTracker.list rejects malformed filters as E_INVALID_PARAMS, not a raw TypeError", () => {
  const t = new ActivityTracker(() => 1000);
  t.set("a", { state: "recalling" });
  for (const [label, q] of [
    ["kinds not an array", { kinds: "recalling" }],
    ["kinds with a non-string", { kinds: [1] }],
    ["agentId not a string", { agentId: 5 }],
    ["since not a string", { since: 5 }],
    ["until not a string", { until: {} }],
    ["cursor not a string", { cursor: 7 }],
  ] as const) {
    it(label, () => {
      assert.throws(() => t.list(q as never, ["a"]), (e: any) => e?.error === "E_INVALID_PARAMS");
    });
  }
});

describe("ActivityTracker person isolation", () => {
  it("a cursor minted for one visibility set is useless to a caller who sees other agents", () => {
    let now = 1000; const t = new ActivityTracker(() => now++);
    for (const a of ["a", "b", "c"]) { t.set(a, { state: "recalling" }); t.idle(a); }
    const first = t.list({ limit: 1 }, ["a", "b"]);
    assert.ok(first.nextCursor);
    assert.throws(() => t.list({ cursor: first.nextCursor! }, ["a", "b", "c"]), (e: any) => e?.error === "E_INVALID_PARAMS");
    assert.throws(() => t.list({ cursor: first.nextCursor! }, ["b"]), (e: any) => e?.error === "E_INVALID_PARAMS");
  });
  it("filtering by an agent the caller cannot see yields nothing, not an error that reveals it exists", () => {
    const t = new ActivityTracker(() => 1000);
    t.set("secret", { state: "dreaming", job: "private-job" });
    assert.deepEqual(t.list({ agentId: "secret" }, ["a"]), { items: [] });
    assert.deepEqual(t.list({ agentId: "nobody" }, ["a"]), { items: [] });
  });
  it("returned items are copies: mutating them does not change the history", () => {
    const t = new ActivityTracker(() => 1000);
    t.set("a", { state: "dreaming", job: "j" });
    const [item] = t.list({}, ["a"]).items; item!.activity.state = "idle"; item!.activity.job = "x";
    assert.equal(t.list({}, ["a"]).items[0]!.activity.state, "dreaming");
    const live = t.get("a"); live.state = "idle";
    assert.equal(t.get("a").state, "dreaming", "get() hands out a copy too");
  });
});

describe("ActivityTracker listeners", () => {
  it("a handler receives a copy: mutating it does not corrupt the tracker", () => {
    const t = new ActivityTracker(() => 1000);
    t.onChange((_id, a) => { a.state = "idle"; });
    t.set("a", { state: "recalling" });
    assert.equal(t.get("a").state, "recalling");
    assert.equal(t.list({}, ["a"]).items[0]!.activity.state, "recalling");
  });
});
