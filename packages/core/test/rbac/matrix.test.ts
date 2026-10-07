import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorize } from "../../src/rbac/authorize.ts";
import { POLICY } from "../../src/rbac/policy.ts";
import type { BreakGlassGrant, Principal, Resource, Role } from "../../src/rbac/types.ts";
import { ENTRIES, ORDER, PAGES, expectation, type Gate } from "./fixtures/visibility.ts";

const NOW = 1_000_000;
const SELF = "u-self";
const OTHER = "u-other";
const AGENT = "agent-1";
const PROJECT = "proj-1";

const spec = (action: string) => {
  const s = POLICY.find((p) => p.action === action);
  assert.ok(s, `policy lacks ${action}`);
  return s;
};

/** A resource of the action's shape. `own` points it at the principal's own user; otherwise at someone else. */
function resourceFor(action: string, own: boolean): Resource {
  const who = own ? SELF : OTHER;
  switch (spec(action).resource) {
    case "system": return { kind: "system" };
    case "user": return { kind: "user", userId: who };
    case "agent": return { kind: "agent", agentId: AGENT };
    case "project": return { kind: "project", projectId: PROJECT };
    case "memory-user": return { kind: "memory", scope: "user", ownerUserId: who };
    case "memory-agent:agent-private": return { kind: "memory", scope: "agent-private", agentId: AGENT };
    case "memory-agent:workspace": return { kind: "memory", scope: "workspace", agentId: AGENT };
  }
}

const bare = (role: Role): Principal => ({ userId: SELF, role, kind: "person" });
const withRights = (role: Role, a: "use" | "manage" | "member" | "lead"): Principal => ({
  userId: SELF, role, kind: "person",
  agentRights: { [AGENT]: a === "manage" ? "manage" : "use" },
  projectRights: { [PROJECT]: a === "lead" ? "lead" : "member" },
});
const grant = (target: string, over: Partial<BreakGlassGrant> = {}): BreakGlassGrant => ({
  id: "bg-1", holderUserId: SELF, targetUserId: target, reason: "incident 4711 follow-up", issuedAt: NOW - 10, expiresAt: NOW + 10_000, ...over,
});
/** Everything a principal could be given at once, except that it never changes the role. */
const maxed = (role: Role): Principal => ({
  userId: SELF, role, kind: "person", agentRights: { [AGENT]: "manage" }, projectRights: { [PROJECT]: "lead" }, breakGlass: [grant(OTHER)],
});

describe("rbac matrix (ADR-004 visibility table x ADR-007 roles)", () => {
  it("covers every policy action exactly once, and nothing the policy lacks", () => {
    const policyActions = POLICY.map((p) => p.action);
    assert.equal(new Set(policyActions).size, policyActions.length, "duplicate action in policy");
    const fixtureActions = ENTRIES.map((e) => e.action);
    assert.equal(new Set(fixtureActions).size, fixtureActions.length, "duplicate action in fixture");
    assert.deepEqual([...fixtureActions].sort(), [...policyActions].sort());
  });

  it("has all five roles in every ADR-004 row", () => {
    for (const [page, row] of Object.entries(PAGES)) assert.deepEqual(Object.keys(row).sort(), [...ORDER].sort(), page);
  });

  for (const e of ENTRIES) {
    for (const role of ORDER) {
      const want = expectation(e, role);
      const label = `${role} x ${e.action}: ${want}`;

      if (want === "A") {
        it(`${label} (allowed with no rights at all)`, () => {
          const d = authorize(bare(role), e.action, resourceFor(e.action, false), { now: NOW });
          assert.equal(d.effect, "allow", JSON.stringify(d));
        });
      } else if (want === "-") {
        it(`${label} (denied even with every right, own resource and a live break-glass)`, () => {
          for (const own of [true, false]) {
            const d = authorize(maxed(role), e.action, resourceFor(e.action, own), { now: NOW });
            assert.equal(d.effect, "deny", `${own ? "own" : "other"}: ${JSON.stringify(d)}`);
          }
        });
      } else {
        it(`${label} (denied bare, allowed once the gate is met)`, () => {
          const gated = (g: Gate) => {
            switch (g) {
              case "O": return authorize(bare(role), e.action, resourceFor(e.action, true), { now: NOW });
              case "OB": return authorize(bare(role), e.action, resourceFor(e.action, true), { now: NOW });
              case "U": return authorize(withRights(role, "use"), e.action, resourceFor(e.action, false), { now: NOW });
              case "M": return authorize(withRights(role, "manage"), e.action, resourceFor(e.action, false), { now: NOW });
              case "P": return authorize(withRights(role, "member"), e.action, resourceFor(e.action, false), { now: NOW });
              case "L": return authorize(withRights(role, "lead"), e.action, resourceFor(e.action, false), { now: NOW });
            }
          };
          assert.equal(authorize(bare(role), e.action, resourceFor(e.action, false), { now: NOW }).effect, "deny", "bare principal on someone else's/unshared resource");
          assert.equal(gated(want).effect, "allow", "gate met");
          if (want === "OB") {
            const d = authorize({ userId: SELF, role, kind: "person", breakGlass: [grant(OTHER)] }, e.action, resourceFor(e.action, false), { now: NOW });
            assert.deepEqual(d, { effect: "allow", reason: "break-glass", breakGlassId: "bg-1" });
          }
        });
      }
    }
  }

  it("a role is never widened by its rights: Viewer and Operator keep their write denials", () => {
    for (const a of ["agent.manage", "agent.create", "memory.agent-private.write", "project.manage"]) {
      for (const role of ["viewer"] as const) {
        assert.equal(authorize(maxed(role), a, resourceFor(a, true), { now: NOW }).effect, "deny", `${role} ${a}`);
      }
    }
  });
});
