import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BINDING, KEY, OTHER_KEY, dbFile, openStore, raw } from "./helpers.ts";
import { abs } from "../helpers/abs.ts";

const T = { timeout: 15_000 };
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

describe("approval store: request detail (D109 §5/§6)", () => {
  it("keeps the harness-computed request detail in the chain and returns it on get/list", T, async () => {
    const { store } = await openStore(dbFile());
    const detail = { tool: "fs.read", risk: "low", flags: { outsideRoots: true }, targets: [abs("/x/a")] };
    const req = store.request({ ...BINDING, capability: "fs.read", detail });
    assert.deepEqual(store.get(req.id)!.detail, detail);
    assert.deepEqual(store.list()[0]!.detail, detail);
    assert.ok(store.verify().ok);
  });

  it("a request without detail has none", T, async () => {
    const { store } = await openStore(dbFile());
    const req = store.request({ ...BINDING, capability: "fs.read" });
    assert.equal(store.get(req.id)!.detail, undefined);
  });

  it("the detail is part of the MAC: rewriting it in the file breaks the chain", T, async () => {
    const path = dbFile();
    const { store, db } = await openStore(path);
    const req = store.request({ ...BINDING, capability: "fs.read", detail: { risk: "low" } });
    db.close();
    const r = raw(path);
    r.prepare("UPDATE approval_chain SET payload = replace(payload, 'low', 'critical') WHERE ref_id = ?").run(req.id);
    r.close();
    const again = await openStore(path);
    assert.equal(again.store.verify().ok, false);
  });
});

describe("approval store: cancel", () => {
  it("cancels a pending request: status cancelled, chained, verifies", T, async () => {
    const { store } = await openStore(dbFile());
    const req = store.request({ ...BINDING, capability: "fs.write" });
    assert.equal(reason(store.cancel(req.id, "christian")), "ok");
    assert.equal(store.get(req.id)!.status, "cancelled");
    assert.ok(store.chain.snapshot().entries.some((e) => e.kind === "approval.cancelled" && e.refId === req.id));
    assert.ok(store.verify().ok);
  });

  it("a cancelled request cannot be decided or consumed, and the nonce is dead", T, async () => {
    const { store } = await openStore(dbFile());
    const req = store.request({ ...BINDING, capability: "fs.write" });
    store.cancel(req.id, "christian");
    assert.equal(reason(store.decide({ requestId: req.id, nonce: req.nonce, decision: "approve", person: "christian", surface: 3 })), "approval-expired");
    assert.equal(reason(store.consume({ ...BINDING, requestId: req.id })), "approval-mismatch");
  });

  it("cancelling twice, an unknown id, or a decided request is refused", T, async () => {
    const { store } = await openStore(dbFile());
    const a = store.request({ ...BINDING, capability: "fs.write" });
    assert.ok(store.cancel(a.id, "christian").ok);
    assert.equal(reason(store.cancel(a.id, "christian")), "approval-used");
    assert.equal(reason(store.cancel("apr_nope", "christian")), "approval-mismatch");
    const b = store.request({ ...BINDING, capability: "fs.write" });
    store.decide({ requestId: b.id, nonce: b.nonce, decision: "approve", person: "christian", surface: 3 });
    assert.equal(reason(store.cancel(b.id, "christian")), "approval-used");
    assert.equal(store.get(b.id)!.status, "approved");
  });

  it("an expired request cannot be cancelled into something else", T, async () => {
    const { store, clock } = await openStore(dbFile(), { ttlMs: 1000 });
    const a = store.request({ ...BINDING, capability: "fs.write" });
    clock.advance(1000);
    assert.equal(reason(store.cancel(a.id, "christian")), "approval-expired");
    assert.equal(store.get(a.id)!.status, "expired");
  });

  it("a cancel entry for a request that was already decided is a binding mismatch for the verifier", T, async () => {
    const path = dbFile();
    const { store, db } = await openStore(path);
    const a = store.request({ ...BINDING, capability: "fs.write" });
    store.decide({ requestId: a.id, nonce: a.nonce, decision: "approve", person: "christian", surface: 3 });
    // A writer holding the key (defence in depth): appends a cancel after the decision.
    store.chain.append("approval.cancelled", a.id, { by: "x", bound: { ...BINDING } });
    const v = store.verify();
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.reason, "binding-mismatch");
    db.close();
    void KEY; void OTHER_KEY;
  });
});
