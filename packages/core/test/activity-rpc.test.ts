import { it } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker } from "../src/activity.ts";
import { buildActivityMethods } from "../src/activity-rpc.ts";
import { guardMethods } from "../src/rbac/guard.ts";
import type { Principal, Role } from "../src/rbac/types.ts";

it("all human roles see exactly their permitted agents; agents and anonymous callers are denied", async () => {
  const tracker = new ActivityTracker(() => 1000);
  tracker.idle("a"); tracker.idle("b"); tracker.idle("c");
  for (const role of ["owner", "admin", "operator", "member", "viewer"] as Role[]) {
    const principal: Principal = { kind: "person", userId: "person-alice", role, agentRights: { a: "use", b: "manage" } };
    const methods = guardMethods(buildActivityMethods(tracker, () => ["a", "b", "c"]), { resolve: () => principal, now: () => 1000 });
    const result = await methods["agent.activity.list"]!({}, { requestId: "request", connectionId: "connection", signal: new AbortController().signal }) as { items: { agentId: string }[] };
    assert.deepEqual(result.items.map(i => i.agentId).sort(), role === "owner" || role === "admin" ? ["a", "b", "c"] : ["a", "b"]);
  }
  for (const principal of [null, { kind: "agent" as const, userId: "agent-alice", role: "owner" as const }]) {
    const methods = guardMethods(buildActivityMethods(tracker, () => ["a"]), { resolve: () => principal, now: () => 1000 });
    await assert.rejects(methods["agent.activity.list"]!({}, { requestId: "request", connectionId: "connection", signal: new AbortController().signal }), (e: any) => e.error === (principal ? "E_DENIED" : "E_UNAUTHORIZED"));
  }
});
