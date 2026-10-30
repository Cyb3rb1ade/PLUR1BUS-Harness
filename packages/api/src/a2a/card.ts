import {
  AgentCard,
  canonicalizeAgentCard,
  generateAgentCardSignature,
  verifyAgentCardSignature,
} from "@a2a-js/sdk";
import { createPrivateKey, type KeyObject } from "node:crypto";

export { canonicalizeAgentCard, generateAgentCardSignature, verifyAgentCardSignature };

export interface SignAgentCardOptions {
  kid?: string | undefined;
  alg?: string | undefined;
}

/**
 * Signs an AgentCard using Ed25519 (EdDSA) JWS / JCS canonicalization.
 */
export async function signAgentCard(
  card: AgentCard,
  key: KeyObject | string,
  options: SignAgentCardOptions = {},
): Promise<AgentCard> {
  const keyObj: KeyObject = typeof key === "string" ? createPrivateKey(key) : key;
  const alg = options.alg ?? "EdDSA";
  const kid = options.kid ?? "default";

  const signer = generateAgentCardSignature(keyObj, {
    alg,
    typ: "JWT",
    kid,
  });

  return signer(card);
}

/**
 * Verifies the signatures on an AgentCard using the provided public key resolver.
 */
export async function verifyAgentCard(
  card: AgentCard,
  publicKeyResolver: (kid: string) => Promise<KeyObject | CryptoKey>,
): Promise<void> {
  const verifier = verifyAgentCardSignature(publicKeyResolver);
  await verifier(card);
}
