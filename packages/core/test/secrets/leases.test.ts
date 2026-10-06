import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS, createLeaseTable } from "../../src/secrets/leases.ts";
import { SecretError } from "../../src/secrets/types.ts";
import { MARKER, fakeClock } from "./helpers.ts";

const invalid = (e: unknown) => e instanceof SecretError && e.code === "lease-invalid";
const opts = { purpose: "embedding", profileId: "openai:key" };

describe("leases (fake clock)", () => {
  it("hands out value, expiry, purpose and profile with the default TTL", () => {
    const c = fakeClock(); const t = createLeaseTable(c);
    const l = t.issue("k", MARKER, opts);
    assert.equal(l.value, MARKER); assert.equal(l.expiresAt, c() + DEFAULT_LEASE_TTL_MS);
    assert.deepEqual([l.purpose, l.profileId, l.name], ["embedding", "openai:key", "k"]);
    assert.match(l.leaseId, /^lse_[0-9a-f]{32}$/);
  });
  it("is readable until its TTL and then gone, exactly at the boundary", () => {
    const c = fakeClock(); const t = createLeaseTable(c);
    const l = t.issue("k", MARKER, { ...opts, ttlMs: 1000 });
    c.advance(999); assert.equal(t.read(l.leaseId).value, MARKER);
    c.advance(1); assert.throws(() => t.read(l.leaseId), invalid);
    assert.deepEqual(t.active(), []);
  });
  it("revokes one lease, and every lease of a name", () => {
    const c = fakeClock(); const t = createLeaseTable(c);
    const a = t.issue("k", MARKER, opts); const b = t.issue("k", MARKER, opts); const o = t.issue("other", "v", opts);
    assert.equal(t.revoke(a.leaseId), true); assert.equal(t.revoke(a.leaseId), false);
    assert.throws(() => t.read(a.leaseId), invalid);
    assert.equal(t.revokeName("k"), 1); assert.throws(() => t.read(b.leaseId), invalid);
    assert.equal(t.read(o.leaseId).value, "v");
  });
  it("caps and validates the TTL", () => {
    const t = createLeaseTable(fakeClock());
    for (const ttlMs of [0, -1, 1.5, MAX_LEASE_TTL_MS + 1, Number.NaN]) assert.throws(() => t.issue("k", "v", { ...opts, ttlMs }), (e) => e instanceof SecretError && e.code === "invalid-ttl");
    assert.ok(t.issue("k", "v", { ...opts, ttlMs: MAX_LEASE_TTL_MS }));
  });
  it("lists active leases without values", () => {
    const t = createLeaseTable(fakeClock()); t.issue("k", MARKER, opts);
    assert.ok(!JSON.stringify(t.active()).includes(MARKER)); assert.equal(t.active().length, 1);
  });
  it("an unknown id is invalid", () => assert.throws(() => createLeaseTable(fakeClock()).read("lse_nope"), invalid));
});
