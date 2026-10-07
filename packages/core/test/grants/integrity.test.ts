import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alwaysCap, call, ctx, decideWith, open, raw } from "./helpers.ts";
import { abs } from "../helpers/abs.ts";

const T = { timeout: 15_000 };
const OUT = { outsideRoots: true };
const pg = { kind: "path", path: abs("/data"), access: "read", recursive: true } as const;
const outRead = () => call({ targets: [abs("/data/x")], flags: OUT });
const q = { person: "christian", agent: "bernd", capability: "fs.read" };

async function three() {
  const s = await open();
  const g1 = s.grants.create(alwaysCap({ id: "g1", match: pg }));
  const g2 = s.grants.create(alwaysCap({ id: "g2", match: pg }));
  const g3 = s.grants.create(alwaysCap({ id: "g3", match: pg }));
  return { s, g1, g2, g3 };
}

describe("grants and the broken chain (D109 §6: fail closed from the break)", () => {
  it("a break at grant 2 suspends grants 2 and 3 but not grant 1; the call falls back to asking when none is left", T, async () => {
    const { s } = await three();
    const created = s.chain.snapshot().byRef.get("g2")!.find((e) => e.kind === "grant.created")!;
    const r = raw(s.path);
    r.prepare("UPDATE approval_chain SET ref_id = ref_id || '' , payload = replace(payload, '\"always\"', '\"always\" ') WHERE seq = ?").run(created.seq);
    r.close();
    const v = s.chain.verify();
    assert.ok(!v.ok);
    assert.equal(v.brokenAt, created.seq);
    assert.deepEqual(s.grants.list(q).map((g) => g.id), ["g1"]);
    assert.equal(s.grants.get("g2"), undefined);
    assert.equal(s.grants.get("g3"), undefined);
    assert.ok(s.grants.get("g1"));
    s.grants.revoke("g1", "christian"); // revocation still works on a broken chain: it only ever narrows
    assert.equal(decideWith(s, outRead(), ctx()).kind, "ask");
  });

  it("a deleted chain entry suspends everything from the gap on", T, async () => {
    const { s } = await three();
    const created = s.chain.snapshot().byRef.get("g2")!.find((e) => e.kind === "grant.created")!;
    const r = raw(s.path);
    r.prepare("DELETE FROM approval_chain WHERE seq = ?").run(created.seq);
    r.close();
    assert.deepEqual(s.grants.list(q).map((g) => g.id), ["g1"]);
  });

  it("a wrong key suspends every grant", T, async () => {
    const { s } = await three();
    const other = await open(s.path, { key: Buffer.alloc(32, 1), clock: s.clock });
    assert.deepEqual(other.grants.list(q), []);
    assert.equal(decideWith(other, outRead(), ctx()).kind, "ask");
  });

  it("a row edited behind the chain's back (scope widened) is suspended", T, async () => {
    const s = await open();
    s.grants.create(alwaysCap({ id: "t", scope: "task", taskId: "t1", match: pg }));
    const r = raw(s.path);
    r.prepare("UPDATE grants SET duration = 'always', task_id = NULL WHERE id = 't'").run();
    r.close();
    assert.equal(s.grants.get("t"), undefined);
    assert.deepEqual(s.grants.list(q), []);
    assert.ok(s.chain.verify().ok, "the chain itself is intact; the row is what disagrees");
  });

  it("a row edited to read-only -> write path or other capability is suspended", T, async () => {
    const { s } = await three();
    const r = raw(s.path);
    r.prepare("UPDATE grants SET match_access = 'write' WHERE id = 'g1'").run();
    r.close();
    assert.equal(s.grants.get("g1"), undefined);
    assert.deepEqual(s.grants.list(q).map((g) => g.id), ["g2", "g3"]);
  });

  it("an un-revoked row does not resurrect a revoked grant (the chain wins)", T, async () => {
    const { s } = await three();
    s.grants.revoke("g2", "christian");
    const r = raw(s.path);
    r.prepare("UPDATE grants SET revoked_at = NULL, end_reason = NULL WHERE id = 'g2'").run();
    r.close();
    assert.deepEqual(s.grants.list(q).map((g) => g.id), ["g1", "g3"]);
    assert.equal(s.grants.get("g2")!.revoked, true);
  });

  it("a reset consumed_at does not resurrect a spent once grant", T, async () => {
    const s = await open();
    s.grants.create(alwaysCap({ id: "o", capability: "fs.write", scope: "once", match: { kind: "action" }, actionHash: "h1" }));
    const who = { person: "christian", agent: "bernd", actionHash: "h1" };
    assert.equal(s.grants.consumeOnce("o", who), true);
    const r = raw(s.path);
    r.prepare("UPDATE grants SET consumed_at = NULL WHERE id = 'o'").run();
    r.close();
    assert.equal(s.grants.consumeOnce("o", who), false);
    assert.deepEqual(s.grants.list({ ...q, capability: "fs.write" }), []);
  });

  it("a once grant on a broken chain cannot be consumed (no throw, no execution)", T, async () => {
    const s = await open();
    s.grants.create(alwaysCap({ id: "o", capability: "fs.write", scope: "once", match: { kind: "action" }, actionHash: "h1" }));
    s.grants.create(alwaysCap({ id: "later", match: pg }));
    const later = s.chain.snapshot().byRef.get("later")![0]!;
    const r = raw(s.path);
    r.prepare("UPDATE approval_chain SET kind = 'grant.created ' WHERE seq = ?").run(later.seq);
    r.close();
    assert.equal(s.grants.consumeOnce("o", { person: "christian", agent: "bernd", actionHash: "h1" }), false);
  });
});
