// Embedding identity hash (G6, ADR-006 "Embedding identity").
//
// The hash covers what defines the vector space: provider, model, revision/pinned upstream, dimensions,
// normalisation, the token cap and the client-side prefix scheme. It deliberately excludes operational settings
// (maxBatch, timeouts, base URL, secret name): two endpoints serving the identical model are the same identity, which
// is what failover within one identity relies on. The format is this package's own; mapping it onto the engine's
// `embedding:v1:sha256:` fingerprint id is the job of the later core integration (see docs/embedding-adapters.md).
import { createHash } from "node:crypto";
import type { EmbeddingIdentity } from "./types.ts";

export const IDENTITY_HASH_PREFIX = "adapter-identity:v1:sha256:";

export function identityHash(identity: EmbeddingIdentity): string {
  // Fixed alphabetical key order; JSON.stringify drops undefined, so "absent" and "undefined" are one identity.
  const canonical = JSON.stringify({
    dimensions: identity.dimensions,
    maxInputTokens: identity.maxInputTokens,
    model: identity.model,
    normalize: identity.normalize,
    passagePrefix: identity.passagePrefix,
    provider: identity.provider,
    queryPrefix: identity.queryPrefix,
    revision: identity.revision,
  });
  return `${IDENTITY_HASH_PREFIX}${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * The subset of the engine's embedding fingerprint (packages/core/src/embedding-migrate/probe.ts `EmbeddingFingerprint`)
 * an adapter can describe. Structurally compatible by construction; not imported, so this package stays free of core.
 */
export interface EmbeddingFingerprintShape {
  provider: string;
  model: string;
  dimensions: number;
  revision?: string;
  endpoint?: string;
  queryPrefix?: string;
  passagePrefix?: string;
  normalize?: boolean;
}

export function toFingerprint(identity: EmbeddingIdentity, endpoint?: string): EmbeddingFingerprintShape {
  return {
    provider: identity.provider,
    model: identity.model,
    dimensions: identity.dimensions,
    normalize: identity.normalize,
    ...(identity.revision !== undefined ? { revision: identity.revision } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(identity.queryPrefix !== undefined ? { queryPrefix: identity.queryPrefix } : {}),
    ...(identity.passagePrefix !== undefined ? { passagePrefix: identity.passagePrefix } : {}),
  };
}
