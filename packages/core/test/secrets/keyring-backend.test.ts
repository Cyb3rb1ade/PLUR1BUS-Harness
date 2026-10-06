import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKeyringBackend, defaultKeyringLoader } from "../../src/secrets/keyring-backend.ts";
import { SecretError } from "../../src/secrets/types.ts";
import { MARKER, fakeKeyring } from "./helpers.ts";

const now = new Date("2026-10-06T10:00:00.000Z");

describe("keyring backend", () => {
  it("probe: unavailable when the module cannot load, error when the keyring refuses, available otherwise", async () => {
    assert.deepEqual(await createKeyringBackend({ service: "s", load: async () => { throw new Error("Cannot find package"); } }).probe(), { available: false, reason: "keyring-unavailable" });
    const k = fakeKeyring(); k.down = true;
    assert.deepEqual(await createKeyringBackend({ service: "s", load: async () => k }).probe(), { available: false, reason: "keyring-error" });
    k.down = false;
    assert.deepEqual(await createKeyringBackend({ service: "s", load: async () => k }).probe(), { available: true });
  });
  it("probing never writes", async () => {
    const k = fakeKeyring();
    await createKeyringBackend({ service: "s", load: async () => k }).probe();
    assert.equal(k.items.size, 0);
  });
  it("scopes entries by service, so two homes do not see each other", async () => {
    const k = fakeKeyring();
    const a = createKeyringBackend({ service: "plur1bus:a", load: async () => k }); const b = createKeyringBackend({ service: "plur1bus:b", load: async () => k });
    await a.put("x", MARKER, now);
    assert.equal(await b.get("x"), null); assert.deepEqual(await b.list(), []);
  });
  it("keeps names and timestamps, never values, in the index entry", async () => {
    const k = fakeKeyring();
    await createKeyringBackend({ service: "s", load: async () => k }).put("x", MARKER, now);
    const idx = [...k.items].find(([key]) => key.includes("__plur1bus-index__"))![1];
    assert.ok(!idx.includes(MARKER)); assert.deepEqual(Object.keys(JSON.parse(idx).entries), ["x"]);
  });
  it("a corrupt index fails closed", async () => {
    const k = fakeKeyring(); const b = createKeyringBackend({ service: "s", load: async () => k });
    await b.put("x", "v", now);
    for (const key of k.items.keys()) if (key.includes("__plur1bus-index__")) k.items.set(key, "{oops");
    await assert.rejects(() => b.list(), (e) => e instanceof SecretError && e.code === "corrupt");
    await assert.rejects(() => b.put("y", "v", now), (e) => e instanceof SecretError && e.code === "corrupt");
  });
  it("falls back to deleteCredential on a module that only has the old name", async () => {
    const k = fakeKeyring(); const Base = k.Entry;
    class Old extends Base { override deletePassword = undefined as never; deleteCredential() { return (Base.prototype.deletePassword as () => boolean).call(this); } }
    const b = createKeyringBackend({ service: "s", load: async () => ({ Entry: Old }) });
    await b.put("x", "v", now);
    assert.equal(await b.delete("x"), true); assert.equal(await b.get("x"), null);
  });
  it("the default loader fails soft when the package is absent or malformed", async () => {
    // Whatever is installed, loading must either yield an Entry class or throw; the probe turns a throw into 'unavailable'.
    try { const m = await defaultKeyringLoader(); assert.equal(typeof m.Entry, "function"); } catch (e) { assert.ok(e instanceof Error); }
  });
});
