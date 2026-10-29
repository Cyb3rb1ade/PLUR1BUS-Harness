import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@plur1bus/config-schema";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { resolveExposure } from "../../src/memory-exposure/index.ts";
import type { Principal } from "../../src/rbac/types.ts";

const ALL = { workspace: true, user: true, agentPrivate: true };
const owner: Principal = { kind: "person", userId: "christian", role: "owner" };
const member = (right?: "use" | "manage"): Principal => ({ kind: "person", userId: "mia", role: "member", ...(right ? { agentRights: { callee: right } } : {}) });
const withExposure = (exposure: NonNullable<HarnessConfig["agents"][string]["memoryExposure"]>): HarnessConfig => {
  const cfg = defaults();
  cfg.agents.callee = { memoryExposure: exposure };
  return cfg;
};
const resolve = (principal: Principal | null, config: HarnessConfig = defaults()) => resolveExposure({ channel: "collab", agentId: "callee", principal, config });

test("every switch defaults to true, also for an agent with no entry at all", () => {
  const e = resolve(owner);
  assert.deepEqual(e.switches, { recall: ALL, capture: true });
  assert.deepEqual(e.recall, ALL);
  assert.equal(e.capture, true);
});

test("an owner and an admin hold every scope; a member needs use for workspace and manage for agent-private", () => {
  assert.deepEqual(resolve({ kind: "person", userId: "ada", role: "admin" }).recall, ALL);
  assert.deepEqual(resolve(member("manage")).recall, ALL);
  assert.deepEqual(resolve(member("use")).recall, { workspace: true, user: true, agentPrivate: false });
  assert.deepEqual(resolve(member()).recall, { workspace: false, user: true, agentPrivate: false });
});

test("rights: agent-private needs manage on the agent asked, not on another agent", () => {
  const other: Principal = { kind: "person", userId: "mia", role: "member", agentRights: { somebody: "manage", callee: "use" } };
  assert.equal(resolve(other).recall.agentPrivate, false);
});

test("each recall switch works on its own and never widens what the principal holds", () => {
  for (const scope of ["workspace", "user", "agentPrivate"] as const) {
    const off = resolve(owner, withExposure({ collab: { recall: { [scope]: false } } })).recall;
    assert.deepEqual(off, { ...ALL, [scope]: false }, scope);
  }
  const widened = resolve(member("use"), withExposure({ collab: { recall: { workspace: true, user: true, agentPrivate: true } } }));
  assert.equal(widened.recall.agentPrivate, false, "a switch that is on cannot grant a right the principal lacks");
});

test("the capture switch is independent of the recall switches", () => {
  const e = resolve(owner, withExposure({ collab: { capture: false } }));
  assert.equal(e.capture, false);
  assert.deepEqual(e.recall, ALL);
  const none = resolve(owner, withExposure({ collab: { recall: { workspace: false, user: false, agentPrivate: false } } }));
  assert.deepEqual(none.recall, { workspace: false, user: false, agentPrivate: false });
  assert.equal(none.capture, true);
});

test("switches are per agent", () => {
  const cfg = defaults();
  cfg.agents.callee = { memoryExposure: { collab: { recall: { user: false } } } };
  cfg.agents.other = {};
  assert.equal(resolveExposure({ channel: "collab", agentId: "callee", principal: owner, config: cfg }).recall.user, false);
  assert.equal(resolveExposure({ channel: "collab", agentId: "other", principal: owner, config: cfg }).recall.user, true);
});

test("no principal, an invalid one, or an agent principal: no person, so no user scope and no capture", () => {
  assert.deepEqual(resolve(null).recall, { workspace: false, user: false, agentPrivate: false });
  assert.equal(resolve(null).capture, false);
  const agent: Principal = { kind: "agent", userId: "a1", role: "owner" };
  const e = resolve(agent);
  assert.equal(e.recall.user, false);
  assert.equal(e.capture, false);
});

test("a token scope that excludes memory narrows the principal too", () => {
  const scoped: Principal = { ...owner, tokenScopes: ["memory.workspace.read"] };
  assert.deepEqual(resolve(scoped).recall, { workspace: true, user: false, agentPrivate: false });
});
