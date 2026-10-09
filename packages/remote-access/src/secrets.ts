// The secret port in practice: an in-memory implementation for tests and for callers that have no store yet, and the
// one place that turns stored key material back into the PEM pair node:tls needs. The key is held in memory only for
// as long as the caller keeps the returned object; this module never writes it anywhere.
import { X509Certificate, createPrivateKey } from "node:crypto";
import type { SecretPort } from "./types.ts";

export interface MemorySecretPort extends SecretPort {
  /** The references currently stored, sorted. */
  refs(): string[];
}

export function createMemorySecretPort(): MemorySecretPort {
  const map = new Map<string, Uint8Array>();
  return {
    async put(ref, value) { map.set(ref, Uint8Array.from(value)); },
    async get(ref) { const v = map.get(ref); return v === undefined ? undefined : Uint8Array.from(v); },
    async delete(ref) { map.delete(ref); },
    refs() { return [...map.keys()].sort(); },
  };
}

export interface TlsMaterial {
  /** PEM private key, for `tls.createServer({ key })`. */
  readonly key: string;
  /** PEM certificate chain, leaf first. */
  readonly cert: string;
}

export async function loadTlsMaterial(secrets: SecretPort, keyRef: string, certPem: string): Promise<TlsMaterial> {
  const stored = await secrets.get(keyRef);
  if (stored === undefined) throw new Error(`secret ${keyRef} not found`);
  const key = Buffer.from(stored).toString("utf8");
  const leaf = new X509Certificate(certPem);
  if (!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error("the stored private key does not match the certificate");
  return { key, cert: certPem };
}
