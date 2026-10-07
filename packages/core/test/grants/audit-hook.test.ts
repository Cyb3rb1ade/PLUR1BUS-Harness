import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openPermissionStores } from "../../src/grants/open.ts";
import { staticKeySource } from "../../src/approvals/keys.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { memoryAuditSink, type AuditSink } from "../../src/rbac/audit.ts";
import { FakeClock, HOUR, KEY, MIN, dbFile } from "./helpers.ts";
import { alwaysCap } from "./helpers.ts";
import { abs } from "../helpers/abs.ts";

const T = { timeout: 15_000 };

async function rig(sinkOverride?: AuditSink) {
  const clock = new FakeClock();
  const mem = memoryAuditSink();
  const sink = sinkOverride ?? mem;
  const audit = createPolicyAudit({ sink, clock, host: "h" });
  const s = await openPermissionStores({ path: dbFile(), keys: staticKeySource(KEY), clock, audit });
  return { s, mem, clock };
}
const actions = (m: { events: { action: string }[] }) => m.events.map((e) => e.action);

describe("grant changes are audited (D109 §9)", () => {
  it("create writes grant.created with who, what, scope, match and surface; no definition body", T, async () => {
    const { s, mem } = await rig();
    const g = s.grants.create(alwaysCap({ match: { kind: "path", path: abs("/work/proj"), access: "read", recursive: true } }));
    assert.deepEqual(actions(mem), ["grant.created"]);
    const e = mem.events[0]!;
    assert.equal(e.target, `grant:${g.id}`);
    assert.equal(e.actor.user, "christian");
    assert.deepEqual(e.detail, {
      person: "christian", agentId: "bernd", capability: "fs.read", grantScope: "always", matchKind: "path", targets: [abs("/work/proj")], by: "christian", decisionSurface: 3, grantId: g.id,
    });
  });

  it("revoke and end-of-task are audited with the reason", T, async () => {
    const { s, mem } = await rig();
    const a = s.grants.create(alwaysCap());
    const b = s.grants.create(alwaysCap({ scope: "task", taskId: "t1" }));
    mem.events.length = 0;
    assert.ok(s.grants.revoke(a.id, "christian"));
    assert.equal(s.grants.endTask("t1", "core"), 1);
    assert.deepEqual(actions(mem), ["grant.revoked", "grant.ended"]);
    assert.equal(mem.events[0]!.detail.by, "christian");
    assert.equal(mem.events[1]!.detail.reason, "task-ended");
    assert.equal(mem.events[1]!.detail.grantId, b.id);
    assert.equal(s.grants.revoke(a.id, "christian"), false);
    assert.equal(mem.events.length, 2, "a no-op revoke writes nothing");
  });

  it("consumeOnce is audited once; the losing caller writes nothing", T, async () => {
    const { s, mem } = await rig();
    const g = s.grants.create({ ...alwaysCap(), scope: "once", match: { kind: "action" }, actionHash: "h1" });
    mem.events.length = 0;
    assert.equal(s.grants.consumeOnce(g.id, { person: "christian", agent: "bernd", actionHash: "h1" }), true);
    assert.equal(s.grants.consumeOnce(g.id, { person: "christian", agent: "bernd", actionHash: "h1" }), false);
    assert.deepEqual(actions(mem), ["grant.consumed"]);
    assert.equal(mem.events[0]!.detail.actionHash, "h1");
  });

  it("markUsed is audited when the use is chained (at most once per granularity window)", T, async () => {
    const { s, mem, clock } = await rig();
    const g = s.grants.create(alwaysCap());
    mem.events.length = 0;
    s.grants.markUsed(g.id);
    s.grants.markUsed(g.id);
    assert.deepEqual(actions(mem), ["grant.used"]);
    clock.advance(HOUR + MIN);
    s.grants.markUsed(g.id);
    assert.deepEqual(actions(mem), ["grant.used", "grant.used"]);
  });

  it("an audit line that cannot be written rolls the creation back: no grant exists that was not recorded", T, async () => {
    const failing: AuditSink = { append() { throw new Error("audit disk full"); } };
    const { s } = await rig(failing);
    assert.throws(() => s.grants.create(alwaysCap()), /audit disk full/);
    assert.equal(s.grants.inspect().length, 0);
    assert.ok(s.chain.verify().ok);
  });

  it("an audit line that cannot be written leaves a once grant unconsumed and nothing runs on it", T, async () => {
    let fail = false;
    const flaky: AuditSink = { append() { if (fail) throw new Error("audit down"); } };
    const { s } = await rig(flaky);
    const g = s.grants.create({ ...alwaysCap(), scope: "once", match: { kind: "action" }, actionHash: "h1" });
    fail = true;
    assert.throws(() => s.grants.consumeOnce(g.id, { person: "christian", agent: "bernd", actionHash: "h1" }), /audit down/);
    fail = false;
    assert.equal(s.grants.consumeOnce(g.id, { person: "christian", agent: "bernd", actionHash: "h1" }), true);
  });

  it("revocation never fails on audit: it only narrows", T, async () => {
    let fail = false;
    const flaky: AuditSink = { append() { if (fail) throw new Error("audit down"); } };
    const { s } = await rig(flaky);
    const g = s.grants.create(alwaysCap());
    fail = true;
    assert.equal(s.grants.revoke(g.id, "christian"), true);
    assert.deepEqual(s.grants.list({ person: "christian", agent: "bernd", capability: "fs.read" }), []);
  });
});
