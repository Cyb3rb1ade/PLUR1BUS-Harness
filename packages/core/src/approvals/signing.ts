// D109 §9.7: Ed25519 signatures on approval.decided chain entries. HMAC-SHA256 stays the chain; this is additive
// evidence for out-of-process verifiers. The private key lives in the secret store (ADR-005), never on disk in the clear.
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { SecretError } from "../secrets/types.ts";
import type { SigningKeySource } from "./keys.ts";

export interface DecisionSigner {
  readonly publicKey: string;
  sign(mac: string): { publicKey: string; signature: string; alg: "Ed25519" };
}

export function verifyDecisionSignature(mac: string, publicKey: string, signature: string): boolean {
  try {
    const pk = createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" });
    if (pk.asymmetricKeyType !== "ed25519") return false;
    return verify(null, Buffer.from(mac, "hex"), pk, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export async function loadDecisionSigner(src: SigningKeySource): Promise<DecisionSigner> {
  return signerFromPkcs8(Buffer.from(await src.load()));
}

function signerFromPkcs8(bytes: Buffer): DecisionSigner {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: bytes, type: "pkcs8", format: "der" });
  } catch {
    throw new SecretError("corrupt", "approval signing identity is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new SecretError("corrupt", "approval signing identity is invalid");
  const publicKey = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
  return {
    publicKey,
    sign(mac: string) {
      return { publicKey, signature: sign(null, Buffer.from(mac, "hex"), key).toString("base64"), alg: "Ed25519" };
    },
  };
}
