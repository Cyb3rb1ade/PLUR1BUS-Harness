import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TokenRecord, TokenStore, TotpRecord, TotpStore, UserDirectory, UserRecord } from "../src/ports.ts";
import { MemoryTokenStore, MemoryTotpStore, MemoryUserDirectory } from "../src/memory-stores.ts";

// `ports.ts` holds only interfaces: erased at runtime, nothing to parse or validate. These tests pin that fact and prove
// the in-memory stores satisfy each port's contract as documented there.

describe("ports module", () => {
  it("loads with no runtime exports and no side effects", async () => {
    const ns = await import("../src/ports.ts");
    assert.deepEqual(Object.keys(ns), []);
  });
});

describe("TokenStore port", () => {
  const rec = (id: string, userId: string, createdAt: number): TokenRecord => ({ id, userId, name: id, scopes: ["agent.*"], hash: "h", createdAt, expiresAt: createdAt + 1000 });

  it("put/get/listByUser/update behave as the port describes", async () => {
    const s: TokenStore = new MemoryTokenStore();
    await s.put(rec("a", "u1", 1)); await s.put(rec("b", "u1", 2)); await s.put(rec("c", "u2", 3));
    assert.equal((await s.get("a"))?.userId, "u1");
    assert.equal(await s.get("zzz"), undefined);
    assert.deepEqual((await s.listByUser("u1")).map((t) => t.id), ["b", "a"], "newest first");
    assert.deepEqual(await s.listByUser("nobody"), []);
    await s.update("a", { lastUsedAt: 5 }); await s.update("a", { revokedAt: 9 }); await s.update("missing", { revokedAt: 1 });
    const a = await s.get("a");
    assert.equal(a?.lastUsedAt, 5); assert.equal(a?.revokedAt, 9);
    assert.equal(await s.get("missing"), undefined);
  });

  it("stored records are frozen copies", async () => {
    const s = new MemoryTokenStore(); const r = rec("a", "u1", 1);
    await s.put(r);
    assert.notEqual(await s.get("a"), r);
    assert.ok(Object.isFrozen(await s.get("a")));
    assert.ok(!s.dump().includes("secret"));
  });
});

describe("TotpStore port", () => {
  it("get/put/delete, and delete of an unknown user is harmless", async () => {
    const s: TotpStore = new MemoryTotpStore();
    const r: TotpRecord = { userId: "u1", secret: "S", enabled: false, createdAt: 1, backupHashes: [] };
    assert.equal(await s.get("u1"), undefined);
    await s.put(r);
    assert.deepEqual(await s.get("u1"), r);
    await s.put({ ...r, enabled: true, lastStep: 7 });
    assert.equal((await s.get("u1"))?.lastStep, 7);
    await s.delete("u1"); await s.delete("u1");
    assert.equal(await s.get("u1"), undefined);
  });
});

describe("UserDirectory port", () => {
  const base: Omit<UserRecord, "version"> = { id: "u1", username: "  Älice ", role: "member" };

  it("finds by normalised username (NFC, trimmed, lower-case) and by id", async () => {
    const d: UserDirectory = new MemoryUserDirectory();
    (d as MemoryUserDirectory).add(base);
    assert.equal((await d.findByUsername("ÄLICE"))?.id, "u1");
    assert.equal((await d.findByUsername("A\u0308lice"))?.id, "u1", "decomposed input matches");
    assert.equal(await d.findByUsername(""), undefined);
    assert.equal((await d.findById("u1"))?.version, 1);
    assert.equal(await d.findById("u2"), undefined);
  });

  it("updatePasswordHash raises the version; change() of an unknown id throws", async () => {
    const d = new MemoryUserDirectory();
    d.add({ ...base, version: 3 });
    await d.updatePasswordHash("u1", "$argon2id$x");
    const u = await d.findById("u1");
    assert.equal(u?.passwordHash, "$argon2id$x");
    assert.equal(u?.version, 4);
    await assert.rejects(d.updatePasswordHash("ghost", "h"), /no user ghost/);
    assert.throws(() => d.change("ghost", {}), /no user ghost/);
  });
});
