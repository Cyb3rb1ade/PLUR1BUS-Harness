// Audit secrets #1 (2026-10-20): with `secrets.fileFallback.enabled` and a keyring that is down, `set` and `delete` reach the
// file only. When the keyring comes back, the older keyring copy must not win (a rotated value coming back as the old one, a
// deleted secret coming back). ADR-005: "an older copy cannot come back". The newer version wins on every read, and a
// delete during the outage leaves a tombstone in the file that hides (and, on return, removes) the keyring copy.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createFileBackend } from "../../src/secrets/file-backend.ts";
import { createKeyringBackend } from "../../src/secrets/keyring-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { SecretError, type SecretPrincipal } from "../../src/secrets/types.ts";
import { fakeClock, fakeKeyring, secure } from "./helpers.ts";

const owner: SecretPrincipal = { kind: "owner", id: "tester" };
const core: SecretPrincipal = { kind: "core" };
const V1 = "value-one-1234567890"; const V2 = "value-two-1234567890"; const V3 = "value-three-1234567890";
const notFound = (e: unknown) => { assert.ok(e instanceof SecretError, String(e)); assert.equal(e.code, "not-found"); return true; };

function rig(fileFallback: () => boolean = () => true) {
  const kr = fakeKeyring();
  const clock = fakeClock();
  const keyring = createKeyringBackend({ service: "plur1bus:test", load: async () => kr });
  const file = createFileBackend({ dir: join(tempDir("p1b-outage-"), "state", "secrets"), secure });
  const audit = createMemoryAuditSink();
  const store = createSecretStore({ keyring, file, fileFallback, audit, clock });
  const outage = () => { kr.down = true; clock.advance(1000); };
  const recovered = () => { kr.down = false; clock.advance(1000); };
  /** What the keyring itself holds for a name, whatever the store would answer. */
  const inKeyring = async (name: string) => { kr.down = false; return keyring.get(name); };
  return { kr, clock, keyring, file, audit, store, outage, recovered, inKeyring };
}

describe("keyring outage with the file fallback on", () => {
  it("a value rotated during the outage wins when the keyring returns, for reveal, lease, list, meta and status", async () => {
    const r = rig();
    await r.store.set(owner, "k", V1, "first");
    r.outage();
    const rotated = await r.store.set(owner, "k", V2);
    assert.equal(rotated.backend, "file");
    r.recovered();
    assert.equal((await r.store.reveal(owner, "k")).value, V2);
    const lease = await r.store.lease(core, "k", { purpose: "p", profileId: "q" });
    assert.equal(lease.value, V2);
    assert.equal((await r.store.meta(owner, "k")).updatedAt, rotated.updatedAt);
    assert.equal((await r.store.status(owner)).secrets!.find((s) => s.name === "k")!.updatedAt, rotated.updatedAt);
    assert.equal((await r.store.list(owner)).find((s) => s.name === "k")!.updatedAt, rotated.updatedAt);
  });

  it("on return the newer value is moved into the keyring and the stale copy is gone from both places", async () => {
    const r = rig();
    await r.store.set(owner, "k", V1);
    r.outage();
    await r.store.set(owner, "k", V2);
    r.recovered();
    await r.store.list(owner); // any owner read settles the two copies
    assert.equal(await r.inKeyring("k"), V2);
    assert.equal(await r.file.get("k"), null);
    assert.deepEqual((await r.keyring.list()).map((m) => m.name), ["k"]);
    assert.ok(r.audit.events.some((e) => e.action === "secret.set" && e.target === "k" && e.principal.kind === "core" && e.detail?.reason === "keyring-sync"), "the sync is audited like any other write");
    // and a later outage cannot bring V1 back: the keyring holds V2 now
    r.outage();
    r.recovered();
    assert.equal((await r.store.reveal(owner, "k")).value, V2);
  });

  it("a secret deleted during the outage stays deleted when the keyring returns, and its keyring copy is removed", async () => {
    const r = rig();
    await r.store.set(owner, "k", V1);
    await r.store.set(owner, "other", V3);
    r.outage();
    // the file copy exists only because an earlier outage rotation put it there
    await r.store.set(owner, "k", V2);
    assert.deepEqual(await r.store.delete(owner, "k"), { removed: true });
    await assert.rejects(() => r.store.reveal(owner, "k"), notFound);
    r.recovered();
    await assert.rejects(() => r.store.reveal(owner, "k"), notFound);
    await assert.rejects(() => r.store.lease(core, "k", { purpose: "p", profileId: "q" }), notFound);
    await assert.rejects(() => r.store.meta(owner, "k"), notFound);
    assert.deepEqual((await r.store.list(owner)).map((s) => s.name), ["other"]);
    assert.deepEqual((await r.store.status(owner)).secrets!.map((s) => s.name), ["other"]);
    assert.equal(await r.inKeyring("k"), null, "the retired keyring copy is purged once the keyring is back");
    assert.deepEqual((await r.keyring.list()).map((m) => m.name), ["other"]);
    assert.deepEqual(await r.file.tombstones!(), {}, "the tombstone is gone once it has done its work");
    assert.equal((await r.store.reveal(owner, "other")).value, V3);
    assert.ok(r.audit.events.some((e) => e.action === "secret.delete" && e.target === "k" && e.principal.kind === "core" && e.detail?.reason === "keyring-sync"));
  });

  it("a delete during the outage of a name that only the keyring holds is not-found and changes nothing (the store cannot see it)", async () => {
    const r = rig();
    await r.store.set(owner, "k", V1);
    r.outage();
    await assert.rejects(() => r.store.delete(owner, "k"), notFound);
    r.recovered();
    assert.equal((await r.store.reveal(owner, "k")).value, V1);
    assert.deepEqual(await r.file.tombstones!(), {});
  });

  it("a secret deleted and written again during the outage comes back as the new value", async () => {
    const r = rig();
    await r.store.set(owner, "k", V1);
    r.outage();
    await r.store.set(owner, "k", V2);
    await r.store.delete(owner, "k");
    r.clock.advance(1000);
    await r.store.set(owner, "k", V3);
    r.recovered();
    assert.equal((await r.store.reveal(owner, "k")).value, V3);
    await r.store.list(owner);
    assert.equal(await r.inKeyring("k"), V3);
    assert.deepEqual(await r.file.tombstones!(), {});
  });

  it("a tombstone never hides a keyring entry written after it", async () => {
    const r = rig();
    await r.file.put("k", V1, new Date(r.clock()));
    r.clock.advance(1000);
    assert.equal(await r.file.delete("k", new Date(r.clock())), true);
    r.clock.advance(1000);
    await r.keyring.put("k", V2, new Date(r.clock()));
    assert.equal((await r.store.reveal(owner, "k")).value, V2);
    await r.store.list(owner);
    assert.equal(await r.inKeyring("k"), V2);
    assert.deepEqual(await r.file.tombstones!(), {});
  });

  it("a keyring copy newer than a file copy wins, and the stale file copy is removed (no stale copy comes back)", async () => {
    const r = rig();
    await r.file.put("k", V1, new Date(r.clock()));
    r.clock.advance(1000);
    await r.keyring.put("k", V2, new Date(r.clock()));
    assert.equal((await r.store.reveal(owner, "k")).value, V2);
    await r.store.list(owner);
    assert.equal(await r.file.get("k"), null);
    assert.equal(await r.inKeyring("k"), V2);
  });

  it("a name only the file holds stays readable when the keyring is back (nothing is lost by the sync)", async () => {
    const r = rig();
    r.outage();
    await r.store.set(owner, "only-file", V1);
    r.recovered();
    assert.equal((await r.store.reveal(owner, "only-file")).value, V1);
    await r.store.list(owner);
    assert.equal((await r.store.reveal(owner, "only-file")).value, V1);
  });

  it("a rotation through the store after the return replaces both copies and clears a pending tombstone", async () => {
    const r = rig();
    await r.store.set(owner, "k", V1);
    r.outage();
    await r.store.set(owner, "k", V2);
    await r.store.delete(owner, "k");
    r.recovered();
    r.clock.advance(1000);
    await r.store.set(owner, "k", V3);
    assert.equal(await r.inKeyring("k"), V3);
    assert.equal(await r.file.get("k"), null);
    assert.deepEqual(await r.file.tombstones!(), {});
    assert.equal((await r.store.reveal(owner, "k")).value, V3);
  });

  it("without the fallback nothing changes: the keyring copy is the only one and a delete removes it", async () => {
    const r = rig(() => false);
    await r.store.set(owner, "k", V1);
    assert.deepEqual(await r.store.delete(owner, "k"), { removed: true });
    await assert.rejects(() => r.store.reveal(owner, "k"), notFound);
  });
});

describe("file backend tombstones", () => {
  const at = new Date("2026-10-20T10:00:00.000Z");
  const mk = () => createFileBackend({ dir: join(tempDir("p1b-tomb-"), "secrets"), secure });
  it("delete with a time leaves a tombstone, put or clearTombstone removes it, other entries and an old file are untouched", async () => {
    const b = mk();
    assert.deepEqual(await b.tombstones!(), {});
    await b.put("a", V1, at); await b.put("b", V2, at);
    assert.equal(await b.delete("a", at), true);
    assert.deepEqual(await b.tombstones!(), { a: at.toISOString() });
    assert.equal(await b.get("b"), V2);
    assert.equal(await b.delete("a", at), false, "nothing to remove: no new tombstone and no error");
    await b.put("a", V3, new Date(at.getTime() + 1));
    assert.deepEqual(await b.tombstones!(), {});
    await b.delete("b", at);
    await b.clearTombstone!("b");
    assert.deepEqual(await b.tombstones!(), {});
    assert.equal(await b.delete("a"), true, "a delete without a time leaves none");
    assert.deepEqual(await b.tombstones!(), {});
  });
  it("is bounded: the oldest tombstones go first", async () => {
    const b = createFileBackend({ dir: join(tempDir("p1b-tomb-"), "secrets"), secure, maxTombstones: 5 });
    for (let i = 0; i < 9; i++) { await b.put(`n${i}`, V1, at); await b.delete(`n${i}`, new Date(at.getTime() + i)); }
    assert.deepEqual(Object.keys(await b.tombstones!()).sort(), ["n4", "n5", "n6", "n7", "n8"]);
  });
});
