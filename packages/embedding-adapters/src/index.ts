// @plur1bus/embedding-adapters: unified remote embedding and rerank adapters (ADR-006, M2).
// Not wired into core or the engine; see docs/embedding-adapters.md for the integration hook points.
export type {
  AdapterDeps, EmbedOptions, EmbeddingAdapter, EmbeddingIdentity, GetSecret, InputType, RerankAdapter, RerankOptions, RerankResult,
} from "./types.ts";
export { AdapterError, ADAPTER_ERROR_KINDS, isAdapterError, type AdapterErrorKind } from "./errors.ts";
export {
  ConfigError, EMBEDDING_PROVIDERS, RERANK_PROVIDERS, resolveEmbeddingSettings, resolveRerankSettings,
  type ConfigIssue, type EmbeddingConfig, type EmbeddingProviderId, type EmbeddingSettings, type RerankConfig, type RerankProviderId, type RerankSettings,
} from "./config.ts";
export { createEmbeddingAdapter, createRerankAdapter } from "./registry.ts";
export { egressHosts, embeddingEgressHosts, rerankEgressHosts, toEgressConfig, type EgressConfigShape, type EgressDeclaration, type EgressHost } from "./egress.ts";
export { identityHash, toFingerprint, IDENTITY_HASH_PREFIX, type EmbeddingFingerprintShape } from "./identity.ts";
export { probe, PROBE_TEXTS, type ProbeCheck, type ProbeOptions, type ProbeOutcome } from "./probe.ts";
export { RERANK_SHAPES, renderRerankMappingTable, type RerankShape, type ShapeStatus } from "./rerank/shapes.ts";
export { redactSecrets } from "./redact.ts";
export { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry.ts";
