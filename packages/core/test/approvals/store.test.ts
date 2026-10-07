import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { ApprovalIntegrityError, type ApprovalStore } from "../../src/approvals/store.ts";
import { BINDING, HOUR, KEY, MIN, dbFile, openStore, raw } from "./helpers.ts";

const T = { timeout: 15_000 };

async function approved(o: { delegable?: boolean } = {}) {
  const path = dbFile();
  const ctx = await openStore(path);
  const req = ctx.store.request({ ...BINDING, capability: "fs.write" });
  const dec = ctx.store.decide({ requestId: req.id, nonce: req.nonce, decision: "approve", person: "christian", surface: 3, ...o });
  assert.ok(dec.ok, JSON.stringify(dec));
  return { path, ...ctx, req };
}
const bind = (requestId: string, over: Record<string, unknown> = {}) => ({ ...BINDING, requestId, ...over });
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

describe("approval store: request, decide, consume (D109 §6 replay protection)", () => {
  it("approve then consume once", T, async () => {
    const { store, req } = await approved();
    assert.equal(reason(store.consume(bind(req.id))), "ok");
  });

  it("a used approval is refused: approval-used", T, async () => {
    const { store, req } = await approved();
    assert.ok(store.consume(bind(req.id)).ok);
    assert.equal(reason(store.consume(bind(req.id))), "approval-used");
  });

  for (const [name, over] of [
    ["another action hash", { actionHash: "h2" }],
    ["another principal", { principal: "mallory" }],
    ["another subject id", { subject: { kind: "agent", id: "other" } }],
    ["another subject kind", { subject: { kind: "subagent", id: "bernd" } }],
    ["another turn", { turnId: "turn2" }],
    ["another task", { taskId: "t2" }],
    ["another session", { sessionId: "s2" }],
  ] as const) {
    it(`${name} is refused: approval-mismatch, and the approval stays usable`, T, async () => {
      const { store, req } = await approved();
      assert.equal(reason(store.consume(bind(req.id, over))), "approval-mismatch");
      assert.equal(reason(store.consume(bind(req.id))), "ok");
    });
  }

  it("an unknown id, a pending request and a denied request are approval-mismatch", T, async () => {
    const { store } = await openStore(dbFile());
    assert.equal(reason(store.consume(bind("apr_nope"))), "approval-mismatch");
    const pending = store.request({ ...BINDING, capability: "fs.write" });
    assert.equal(reason(store.consume(bind(pending.id))), "approval-mismatch");
    const denied = store.request({ ...BINDING, capability: "fs.write" });
    assert.ok(store.decide({ requestId: denied.id, nonce: denied.nonce, decision: "deny", person: "christian", surface: 3 }).ok);
    assert.equal(reason(store.consume(bind(denied.id))), "approval-mismatch");
  });

  it("an expired request cannot be decided or consumed: approval-expired", T, async () => {
    const { store, clock } = await openStore(dbFile(), { ttlMs: 10 * MIN });
    const a = store.request({ ...BINDING, capability: "fs.write" });
    clock.advance(10 * MIN);
    assert.equal(reason(store.decide({ requestId: a.id, nonce: a.nonce, decision: "approve", person: "christian", surface: 3 })), "approval-expired");
    const b = store.request({ ...BINDING, capability: "fs.write" });
    assert.ok(store.decide({ requestId: b.id, nonce: b.nonce, decision: "approve", person: "christian", surface: 3 }).ok);
    clock.advance(10 * MIN);
    assert.equal(reason(store.consume(bind(b.id))), "approval-expired");
  });

  it("the default request lifetime is 24 h (denied after that, never auto-approved)", T, async () => {
    const { store, clock } = await openStore(dbFile());
    const a = store.request({ ...BINDING, capability: "fs.write" });
    assert.equal(a.expiresAt - clock.now(), 24 * HOUR);
  });

  it("the nonce is single-use: a second decide is approval-used, a wrong nonce approval-mismatch", T, async () => {
    const { store } = await openStore(dbFile());
    const r = store.request({ ...BINDING, capability: "fs.write" });
    assert.equal(reason(store.decide({ requestId: r.id, nonce: "0".repeat(32), decision: "approve", person: "christian", surface: 3 })), "approval-mismatch");
    assert.ok(store.decide({ requestId: r.id, nonce: r.nonce, decision: "approve", person: "christian", surface: 3 }).ok);
    assert.equal(reason(store.decide({ requestId: r.id, nonce: r.nonce, decision: "approve", person: "christian", surface: 3 })), "approval-used");
  });

  it("only the request's principal can decide it", T, async () => {
    const { store } = await openStore(dbFile());
    const r = store.request({ ...BINDING, capability: "fs.write" });
    assert.equal(reason(store.decide({ requestId: r.id, nonce: r.nonce, decision: "approve", person: "mallory", surface: 3 })), "approval-mismatch");
  });

  it("state survives reopening the file: a used approval stays used", T, async () => {
    const { path, store, db, req } = await approved();
    assert.ok(store.consume(bind(req.id)).ok);
    db.close();
    const again = await openStore(path);
    assert.equal(reason(again.store.consume(bind(req.id))), "approval-used");
  });

  it("two stores on one file: exactly one consume wins", T, async () => {
    const { path, store, req } = await approved();
    const other = await openStore(path);
    const results = [store.consume(bind(req.id)), other.store.consume(bind(req.id))].map(reason).sort();
    assert.deepEqual(results, ["approval-used", "ok"]);
  });

  it("records the decision (person, surface, delegable) in the chain", T, async () => {
    const { store, req } = await approved({ delegable: true });
    const rec = store.get(req.id)!;
    assert.deepEqual([rec.status, rec.decidedBy, rec.decisionSurface, rec.delegable], ["approved", "christian", 3, true]);
  });
});

describe("approval store: verify() (D109 §6 integrity and replay)", () => {
  it("a clean store verifies", T, async () => {
    const { store, req } = await approved();
    store.consume(bind(req.id));
    const v = store.verify();
    assert.ok(v.ok);
    assert.equal(v.ok && v.entries, 3);
  });

  it("tampering with the recorded decision is caught at its position and consume fails closed", T, async () => {
    const { path, store, req } = await approved();
    const r = raw(path);
    r.prepare("UPDATE approval_chain SET payload = replace(payload, 'approve', 'denied') WHERE kind = 'approval.decided'").run();
    r.close();
    const v = store.verify();
    assert.ok(!v.ok);
    assert.deepEqual([v.brokenAt, v.reason], [2, "mac-mismatch"]);
    assert.throws(() => store.consume(bind(req.id)), ApprovalIntegrityError);
  });

  it("editing only the projection table cannot turn a denial into an approval", T, async () => {
    const path = dbFile();
    const { store } = await openStore(path);
    const d = store.request({ ...BINDING, capability: "fs.write" });
    store.decide({ requestId: d.id, nonce: d.nonce, decision: "deny", person: "christian", surface: 3 });
    const r = raw(path);
    r.prepare("UPDATE approvals SET status = 'approved'").run();
    r.close();
    assert.equal(reason(store.consume(bind(d.id))), "approval-mismatch");
  });

  it("deleting the 'used' entry (to replay) is caught", T, async () => {
    const { path, store, req } = await approved();
    assert.ok(store.consume(bind(req.id)).ok);
    const r = raw(path);
    r.prepare("DELETE FROM approval_chain WHERE kind = 'approval.used'").run();
    r.prepare("UPDATE approvals SET status = 'approved'").run();
    r.close();
    const v = store.verify();
    assert.ok(!v.ok);
    assert.deepEqual([v.brokenAt, v.reason], [3, "truncated"]);
    assert.throws(() => store.consume(bind(req.id)), ApprovalIntegrityError);
  });

  it("a validly keyed but replayed nonce is caught (defence in depth)", T, async () => {
    const { store, req } = await approved();
    const other = store.request({ ...BINDING, capability: "fs.write" });
    const forged = store.chain.append("approval.decided", other.id, { decision: "approve", person: "christian", surface: 3, delegable: false, bound: { ...BINDING } }, req.nonce);
    const v = store.verify();
    assert.ok(!v.ok);
    assert.deepEqual([v.brokenAt, v.reason], [forged.seq, "nonce-reuse"]);
  });

  it("a validly keyed 'used' entry bound to other arguments is caught (defence in depth)", T, async () => {
    const { store, req } = await approved();
    const e = store.chain.append("approval.used", req.id, { bound: { ...BINDING, actionHash: "evil" } });
    const v = store.verify();
    assert.ok(!v.ok);
    assert.deepEqual([v.brokenAt, v.reason], [e.seq, "binding-mismatch"]);
  });

  it("a second 'used' entry for one request cannot be written at all", T, async () => {
    const { store, req } = await approved();
    assert.ok(store.consume(bind(req.id)).ok);
    assert.throws(() => store.chain.append("approval.used", req.id, { bound: { ...BINDING } }));
  });
});

describe("approval store: the key stays off the disk (D109 §6)", () => {
  it("neither the database nor its WAL contain the key", T, async () => {
    const { path, store, db } = await approved();
    const r = store.request({ ...BINDING, capability: "fs.write" });
    store.decide({ requestId: r.id, nonce: r.nonce, decision: "approve", person: "christian", surface: 3 });
    db.exec("PRAGMA wal_checkpoint(FULL)");
    for (const f of [path, `${path}-wal`]) {
      if (!existsSync(f)) continue;
      const bytes = readFileSync(f);
      for (const needle of [Buffer.from(KEY), Buffer.from(KEY.toString("hex")), Buffer.from(KEY.toString("base64"))]) {
        assert.equal(bytes.includes(needle), false, f);
      }
    }
  });

  it("the store type exposes no key", T, async () => {
    const { store } = await approved();
    assert.equal(JSON.stringify(Object.keys(store)).includes("key"), false);
    assert.equal(JSON.stringify(store).includes(KEY.toString("hex")), false);
    const _typed: ApprovalStore = store;
    assert.ok(_typed);
  });
});
