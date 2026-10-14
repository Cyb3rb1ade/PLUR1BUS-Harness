// B08: invariants of the capability table, so a new row cannot silently create a capability that is askable by no one,
// lowerable below its floor or grantable above its surface.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, NEVER_CAPABILITIES, capabilityOf, riskRank, scopeRank } from "../../src/policy/index.ts";

describe("capability table invariants", () => {
  it("capabilityOf resolves ids and refuses everything else, including inherited property names", () => {
    assert.equal(capabilityOf("fs.read")?.id, "fs.read");
    for (const bad of ["", "FS.READ", "constructor", "__proto__", "toString"]) assert.equal(capabilityOf(bad), undefined, bad);
  });
  for (const [id, d] of CAPABILITIES) {
    it(`${id}: ids are unique, lower-case and the table key`, () => {
      assert.equal(d.id, id);
      assert.equal(id, id.toLowerCase());
    });
    it(`${id}: a class that can ask has a surface that may decide, a never class has no way in`, () => {
      const asks = d.base.inside === "approval" || d.base.outside === "approval";
      if (asks) assert.notEqual(d.minSurface, null, "approval class without a deciding surface");
      if (d.base.inside === "never" || d.base.outside === "never") {
        assert.equal(d.base.inside, "never");
        assert.equal(d.base.outside, "never");
        assert.equal(d.ceiling, null);
        assert.equal(d.lowerable, false);
        assert.ok(NEVER_CAPABILITIES.includes(id));
      }
    });
    it(`${id}: nothing at surface 3 or with a once-only ceiling is lowerable; critical risk needs surface 3 for 'always'`, () => {
      if (d.minSurface === 3 || d.ceiling === "once") assert.equal(d.lowerable, false);
      if (d.baseRisk === "critical" && d.base.inside !== "never") assert.equal(d.minSurface, 3);
      assert.ok(riskRank(d.baseRisk) >= 0 && (d.ceiling === null || scopeRank(d.ceiling) >= 0));
    });
  }
});
