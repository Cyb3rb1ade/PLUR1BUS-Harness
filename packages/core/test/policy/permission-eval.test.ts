import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NEVER_CAPABILITIES, type Decision, type SubjectKind, type SurfaceTrust } from "../../src/policy/index.ts";
import { call, ctx, grant, run } from "./helpers.ts";
import { ROWS, type Scenario } from "./permission-eval.fixtures.ts";

const TIMEOUT = { timeout: 10_000 };

function evaluate(s: Scenario): Decision {
  return run(call(s.call), ctx(s.ctx), s.grants ?? []);
}

describe("permission-eval", () => {
  it("has at least 40 scenarios with unique ids", TIMEOUT, () => {
    assert.ok(ROWS.length >= 40, `only ${ROWS.length}`);
    assert.equal(new Set(ROWS.map((r) => r.id)).size, ROWS.length);
  });

  for (const row of ROWS) {
    it(`attack: ${row.id} — ${row.what}`, TIMEOUT, () => {
      assert.notEqual(row.attack.expect, "allow", "an attack row must expect ask or deny");
      const d = evaluate(row.attack);
      assert.notEqual(d.kind, "allow", `ESCAPE: ${JSON.stringify(d)}`);
      assert.equal(d.kind, row.attack.expect);
      if (d.kind === "deny" && row.attack.rule) assert.equal(d.rule, row.attack.rule);
    });
  }

  it("zero escapes: no attack row is ever allowed", TIMEOUT, () => {
    const escapes = ROWS.filter((r) => evaluate(r.attack).kind === "allow").map((r) => r.id);
    assert.deepEqual(escapes, []);
  });

  it("at least 95 % of the benign twins are allowed", TIMEOUT, () => {
    const blocked = ROWS.filter((r) => evaluate(r.benign).kind !== "allow").map((r) => r.id);
    const rate = (ROWS.length - blocked.length) / ROWS.length;
    assert.ok(rate >= 0.95, `over-blocked (${(rate * 100).toFixed(1)} %): ${blocked.join(", ")}`);
    assert.deepEqual(blocked, []); // the stricter bar this table meets today; a regression shows up by name
  });

  describe("never capabilities are refused on every surface and subject", () => {
    const surfaces: SurfaceTrust[] = [0, 1, 2, 3];
    const subjects: SubjectKind[] = ["agent", "subagent", "acp-agent", "mcp-client", "acp-editor", "remote-harness", "a2a-peer"];
    it("covers the three named by the spec and the rest of the floor", TIMEOUT, () => {
      for (const id of ["credential.entry", "policy.bypass", "harness.admin", "captcha.solve", "input.monitor"]) assert.ok(NEVER_CAPABILITIES.includes(id), id);
    });
    for (const cap of ["credential.entry", "policy.bypass", "harness.admin", "captcha.solve", "input.monitor"]) {
      it(cap, TIMEOUT, () => {
        for (const surface of surfaces) for (const kind of subjects) {
          const x = ctx({
            surface, subject: { kind, agentId: "bernd" }, overrides: { [cap]: "allowed" }, tokenScopes: [cap],
            handoff: { scope: [cap], taskId: "t1", approvalsHeld: ["g1"] },
          });
          const g = [grant(cap, "always", undefined, { id: "g1", delegable: true, taskId: "t1" }), grant(cap, "once")];
          const d = run(call({ capability: cap }), x, g);
          assert.equal(d.kind, "deny", `${cap} ${kind} T${surface}`);
          if (d.kind === "deny") assert.ok(d.reason === "policy-never" || d.reason === "surface-untrusted");
        }
      });
    }
  });
});
