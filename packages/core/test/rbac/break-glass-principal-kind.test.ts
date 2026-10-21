// Defense in depth: break-glass is for people. The RPC rule is humanOnly; the library refuses a non-person principal too.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBreakGlass, BreakGlassError } from "../../src/rbac/break-glass.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";

const REASON = "ticket 4711: user reports missing memories";
const person = (role: "owner" | "admin"): Principal => ({ userId: `${role}-1`, role, kind: "person" });
const agent = (role: "owner" | "admin"): Principal => ({ userId: `${role}-1`, role, kind: "agent" });
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof BreakGlassError ? e.code : `other:${String(e)}`; } return "no-throw"; };

function setup() {
  const audit = memoryAuditSink();
  let n = 0;
  const bg = createBreakGlass({ audit, notify: () => {}, clock: () => 1_000_000, idGen: () => `g${++n}`, host: "test-host" });
  return { bg, audit };
}

describe("break-glass: only people request and revoke", () => {
  for (const role of ["owner", "admin"] as const) {
    it(`an agent principal with role ${role} is refused a request: no grant, no audit entry, no notice`, () => {
      const { bg, audit } = setup();
      assert.equal(code(() => bg.request(agent(role), { targetUserId: "u2", reason: REASON, ttlMs: 60_000 })), "not-permitted");
      assert.equal(audit.events.length, 0);
      assert.deepEqual(bg.active(`${role}-1`), []);
    });
  }

  it("an agent principal cannot revoke a person's grant, even with role owner; the grant stays live", () => {
    const { bg } = setup();
    const g = bg.request(person("admin"), { targetUserId: "u2", reason: REASON, ttlMs: 60_000 });
    assert.equal(code(() => bg.revoke(agent("owner"), g.id)), "not-permitted");
    assert.equal(bg.active("admin-1").length, 1);
  });

  it("a person holder and a person Owner still request and revoke as before", () => {
    const { bg } = setup();
    const g = bg.request(person("admin"), { targetUserId: "u2", reason: REASON, ttlMs: 60_000 });
    bg.revoke(person("owner"), g.id);
    const h = bg.request(person("owner"), { targetUserId: "u2", reason: REASON, ttlMs: 60_000 });
    bg.revoke(person("owner"), h.id);
    assert.deepEqual(bg.active("admin-1"), []);
  });
});
