import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKeyringBackend, defaultKeyringLoader, KEYRING_ENTRY_OPTIONS, type KeyringEntryOptions } from "../../src/secrets/keyring-backend.ts";
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
  it("every entry is pinned to the Secret Service, and a binding that refuses the pin is a keyring that is not there (P4D-34)", async () => {
    // The same literal as `entryOptions("linux")` of scripts/ci/keyring-probe.mjs, which proves it against a real Secret Service.
    assert.deepEqual(KEYRING_ENTRY_OPTIONS, { linux: { store: "secret-service" } });
    const k = fakeKeyring(), seen: (KeyringEntryOptions | undefined)[] = [];
    class Recording extends k.Entry { constructor(service: string, user: string, options?: KeyringEntryOptions) { super(service, user); seen.push(options); } }
    const b = createKeyringBackend({ service: "s", load: async () => ({ Entry: Recording }) });
    await b.probe(); await b.put("x", MARKER, now); assert.equal(await b.get("x"), MARKER); await b.describe("x", "what it is for", now); await b.list(); await b.delete("x");
    assert.ok(seen.length >= 8 && seen.every((o) => o === KEYRING_ENTRY_OPTIONS), "the probe, the index and every credential");
    // What @napi-rs/keyring 2.1.0 does on a host without a Secret Service: pinned, the constructor throws; left to
    // itself it would hand out an entry of the kernel keyring, which this fake stands for with a working entry.
    const h = fakeKeyring();
    class NoSecretService extends h.Entry { constructor(service: string, user: string, options?: KeyringEntryOptions) { super(service, user); if (options?.linux?.store === "secret-service") throw new Error("the Secret Service is not available"); } }
    const headless = createKeyringBackend({ service: "s", load: async () => ({ Entry: NoSecretService }) });
    assert.deepEqual(await headless.probe(), { available: false, reason: "keyring-unavailable" });
    await assert.rejects(() => headless.put("y", MARKER, now), (e) => e instanceof SecretError && e.code === "backend-unavailable");
    await assert.rejects(() => headless.get("y"), (e) => e instanceof SecretError && e.code === "backend-unavailable");
    assert.equal(h.items.size, 0, "nothing was written anywhere");
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
