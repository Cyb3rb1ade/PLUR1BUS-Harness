// D109 §6: the per-installation HMAC key lives in the secret store (ADR-005), never on disk in the clear.
// The chain takes it through this interface so tests inject a fixed key and the core injects the secret store.
import { randomBytes } from "node:crypto";
import { SecretError, type SecretPrincipal } from "../secrets/types.ts";
import type { SecretStore } from "../secrets/store.ts";

export const MIN_KEY_BYTES = 32;
export const CHAIN_KEY_SECRET_NAME = "approvals.chain-key.v1";

export interface ChainKeySource {
  /** The key bytes (at least 32). Called once when a store opens; the key is then held in memory only. */
  load(): Promise<Uint8Array>;
}

export function assertKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length < MIN_KEY_BYTES) throw new RangeError(`approval chain key must be at least ${MIN_KEY_BYTES} bytes`);
  return key;
}

export function staticKeySource(key: Uint8Array): ChainKeySource {
  const copy = Uint8Array.from(assertKey(key));
  return { load: async () => Uint8Array.from(copy) };
}

export interface SecretKeySourceOptions {
  name?: string;
  /** Reads the key (`lease` is available to `core`). */
  reader?: SecretPrincipal;
  /** Creates the key on first start (`set` is owner-only in the secret store). */
  creator?: SecretPrincipal;
}

/**
 * Reads the chain key from the secret store, creating a random 32-byte key on first use. A stored value that is not a
 * valid key is `corrupt` and is never replaced silently: replacing it would orphan every existing chain entry.
 * Creation assumes one core process (the core lock): two racing creators would each win their own write.
 */
export function secretStoreKeySource(store: SecretStore, o: SecretKeySourceOptions = {}): ChainKeySource {
  const name = o.name ?? CHAIN_KEY_SECRET_NAME;
  const reader: SecretPrincipal = o.reader ?? { kind: "core" };
  const creator: SecretPrincipal = o.creator ?? { kind: "owner", id: "core" };
  const read = async (): Promise<Uint8Array> => {
    const lease = await store.lease(reader, name, { purpose: "approvals-chain", profileId: "core", ttlMs: 5000 });
    try {
      const bytes = Buffer.from(lease.value, "base64");
      if (bytes.length < MIN_KEY_BYTES) throw new SecretError("corrupt", `secret ${name} is corrupt: not a ${MIN_KEY_BYTES}-byte key`, { name });
      return Uint8Array.from(bytes);
    } finally {
      store.revokeLease(reader, lease.leaseId);
    }
  };
  return {
    async load() {
      try {
        return await read();
      } catch (e) {
        if (!(e instanceof SecretError) || e.code !== "not-found") throw e;
      }
      await store.set(creator, name, randomBytes(MIN_KEY_BYTES).toString("base64"));
      return read();
    },
  };
}
