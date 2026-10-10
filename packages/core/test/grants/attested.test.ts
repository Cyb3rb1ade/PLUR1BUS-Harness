import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alwaysCap, open, raw } from "./helpers.ts";

const T = { timeout: 15_000 };

describe("a grant remembers the OS attestation that lifted it", () => {
  it("stores attestedVia, returns it on read, and chains it with the definition", T, async () => {
    const s = await open();
    const g = s.grants.create(alwaysCap({ id: "g1", surface: 2, attestedVia: "attested:touch-id" }));
    assert.equal(g.attestedVia, "attested:touch-id");
    assert.equal(s.grants.inspect().find((v) => v.grant.id === "g1")!.grant.attestedVia, "attested:touch-id");
    assert.ok(s.chain.verify().ok);
    assert.equal(s.chain.snapshot().byRef.get("g1")!.find((e) => e.kind === "grant.created")!.payload.includes("attested:touch-id"), true);
  });

  it("a grant without one has no attestedVia, and its definition is byte-identical to before", T, async () => {
    const s = await open();
    const g = s.grants.create(alwaysCap({ id: "g1" }));
    assert.equal(g.attestedVia, undefined);
    assert.ok(!s.chain.snapshot().byRef.get("g1")!.find((e) => e.kind === "grant.created")!.payload.includes("attestedVia"));
  });

  it("erasing or forging the origin in the row suspends the grant (the chained definition no longer matches)", T, async () => {
    for (const sql of ["UPDATE grants SET attested_via = NULL WHERE id = 'g1'", "UPDATE grants SET attested_via = 'attested:forged' WHERE id = 'g1'"]) {
      const s = await open();
      s.grants.create(alwaysCap({ id: "g1", surface: 2, attestedVia: "attested:touch-id" }));
      const r = raw(s.path); r.exec(sql); r.close();
      assert.equal(s.grants.get("g1"), undefined, sql);
    }
  });

  it("refuses a malformed origin", T, async () => {
    const s = await open();
    assert.throws(() => s.grants.create(alwaysCap({ surface: 2, attestedVia: "touch-id" })), /attested/);
    assert.throws(() => s.grants.create(alwaysCap({ surface: 2, attestedVia: "attested:" + "x".repeat(80) })), /attested/);
  });

  it("an attested origin is only possible on T2 or above", T, async () => {
    const s = await open();
    assert.throws(() => s.grants.create(alwaysCap({ surface: 1, attestedVia: "attested:touch-id" })), /attested/);
  });
});
