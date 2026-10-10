// Persistent export signing identity lives in ADR-005's secret backend, leased only while signing.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { SecretStore } from "../secrets/store.ts";
import { SecretError } from "../secrets/types.ts";
export const EXPORT_SIGNING_KEY = "agent.export-signing.v1";
export function agentExportSigner(store: SecretStore) {
  let opening: Promise<void> | undefined;
  const ensure = () => opening ??= (async () => {
    try { const lease = await store.lease({ kind: "core" }, EXPORT_SIGNING_KEY, { purpose: "agent-export", profileId: "core", ttlMs: 5000 }); store.revokeLease({ kind: "core" }, lease.leaseId); }
    catch (e) {
      if (!(e instanceof SecretError) || e.code !== "not-found") throw e;
      const { privateKey } = generateKeyPairSync("ed25519");
      await store.set({ kind: "owner", id: "core" }, EXPORT_SIGNING_KEY, privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
    }
  })().catch(e => { opening = undefined; throw e; });
  return async (hash: string) => {
    await ensure();
    const lease = await store.lease({ kind: "core" }, EXPORT_SIGNING_KEY, { purpose: "agent-export", profileId: "core", ttlMs: 5000 });
    try {
      const bytes = Buffer.from(lease.value, "base64");
      try { const key = createPrivateKey({ key: bytes, type: "pkcs8", format: "der" }); if (key.asymmetricKeyType !== "ed25519") throw new SecretError("corrupt", "export signing identity is invalid"); return { publicKey: createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64"), signature: sign(null, Buffer.from(hash, "hex"), key).toString("base64") }; }
      finally { bytes.fill(0); }
    } finally { store.revokeLease({ kind: "core" }, lease.leaseId); }
  };
}

/** Exact secret canaries for export redaction, never returned to the RPC caller. All leases are revoked immediately. */
export async function exportSecretCanaries(store: SecretStore): Promise<string[]> {
  const values: string[] = [];
  for (const meta of await store.list({ kind: "owner", id: "core" })) {
    const lease = await store.lease({ kind: "core" }, meta.name, { purpose: "export-redaction", profileId: "core", ttlMs: 5000 });
    try { values.push(lease.value); } finally { store.revokeLease({ kind: "core" }, lease.leaseId); }
  }
  return values;
}
