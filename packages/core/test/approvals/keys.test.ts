import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { CHAIN_KEY_SECRET_NAME, secretStoreKeySource, staticKeySource } from "../../src/approvals/keys.ts";

const T = { timeout: 15_000 };
const mkStore = () => {
  const keyring = createMemoryBackend();
  const store = createSecretStore({ keyring, file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() });
  return { store, keyring };
};

describe("approval chain key sources", () => {
  it("staticKeySource returns the key and refuses short ones", T, async () => {
    const k = Buffer.alloc(32, 1);
    assert.deepEqual(Buffer.from(await staticKeySource(k).load()), k);
    assert.throws(() => staticKeySource(Buffer.alloc(8)), /at least 32 bytes/);
  });

  it("the secret-store source creates a 32-byte key on first use and returns the same key afterwards", T, async () => {
    const { store, keyring } = mkStore();
    const src = secretStoreKeySource(store);
    const a = await src.load();
    const b = await secretStoreKeySource(store).load();
    assert.equal(a.length, 32);
    assert.deepEqual(Buffer.from(a), Buffer.from(b));
    assert.ok(keyring.dump().has(CHAIN_KEY_SECRET_NAME));
  });

  it("a corrupt (too short) stored key fails closed instead of being replaced", T, async () => {
    const { store } = mkStore();
    await store.set({ kind: "owner", id: "t" }, CHAIN_KEY_SECRET_NAME, Buffer.alloc(4).toString("base64"));
    await assert.rejects(() => secretStoreKeySource(store).load(), /corrupt/);
  });
});
