// The target fingerprint for `memory reembed --plan`: built with the engine's own functions (normalisation of the target
// embedding block, then the fingerprint of that normalised config), so the revision, artefact hashes and endpoint are the
// ones the engine derives at start. Every direction is allowed (owner decision 2026-10-18: local→cloud, cloud→local,
// cloud→cloud, local→local); a target is refused only by the provider rules: missing details, a key in the configuration,
// a missing privacy acknowledgment, privacy.localOnly (resolveEmbeddingProvider) and, at the RPC layer, egress.
import type { PrivacyAcknowledgment } from "@plur1bus/config-schema";
import { embeddingFingerprintFromNormalizedConfig } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/runtime-config.js";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import { resolveEmbeddingProvider, type ProviderPolicy } from "../composition/embedding-policy.ts";
import { refuseTarget, type EmbeddingFingerprint, type ProbeResult } from "./probe.ts";
import { localEndpoints, localOnlyShared } from "../privacy/local-only.ts";

export interface TargetModel { model: string; dimensions?: number; queryPrefix?: string; passagePrefix?: string }
/** A target of any provider. Without `provider` (or with `local-transformers`) it is a pinned local model. */
export interface TargetSpec extends TargetModel { provider?: string; baseUrl?: string; apiKeyEnv?: string }
/** What a cloud target is checked against: the text-embedding acknowledgment and privacy.localOnly. */
export interface TargetPolicy extends ProviderPolicy { privacyAck?: PrivacyAcknowledgment }

/** The engine's key reference for a target that reads its key from the core's environment (never the key itself). */
export interface EnvSecretRef { source: "env"; provider: "default"; id: string }
export type TargetResult =
  | { ok: true; local: true; fingerprint: EmbeddingFingerprint }
  | { ok: true; local: false; fingerprint: EmbeddingFingerprint; apiKeyEnv: string; secretRef: EnvSecretRef; block: Record<string, unknown> }
  | { ok: false; probe: ProbeResult };

export const LOCAL_PROVIDER = "local-transformers";
export const isLocalTarget = (provider: string | undefined): boolean => provider === undefined || provider === LOCAL_PROVIDER;

export function targetFromModel(t: TargetModel): { ok: true; fingerprint: EmbeddingFingerprint } | { ok: false; probe: ProbeResult } {
  try {
    const local: Record<string, unknown> = { model: t.model, ...(t.dimensions !== undefined ? { dimensions: t.dimensions } : {}), ...(t.queryPrefix !== undefined ? { queryPrefix: t.queryPrefix } : {}), ...(t.passagePrefix !== undefined ? { passagePrefix: t.passagePrefix } : {}) };
    const n = normalizeEmbeddingConfig({ provider: LOCAL_PROVIDER, local });
    return { ok: true, fingerprint: embeddingFingerprintFromNormalizedConfig({ ...n, dimensions: n.dimensions }) as unknown as EmbeddingFingerprint };
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    return { ok: false, probe: refuseTarget("target-model-unpinned", `the target model is not a pinned local embedding model the harness can run (${why})`) };
  }
}

/**
 * Any provider. A local target goes through `targetFromModel`; a cloud or self-hosted one through the same provider rules
 * the engine start applies (`resolveEmbeddingProvider`, which throws the RpcError: E_INVALID_PARAMS for missing details,
 * E_DENIED reason privacy-acknowledgment-required or local-only), then the engine's own normalisation and fingerprint.
 */
export function targetFromSpec(spec: TargetSpec, policy: TargetPolicy = {}): TargetResult {
  if (isLocalTarget(spec.provider)) {
    if (spec.baseUrl !== undefined || spec.apiKeyEnv !== undefined) {
      return { ok: false, probe: refuseTarget("target-identity-invalid", "a local-transformers target runs on this machine; baseUrl and apiKeyEnv belong to a remote provider") };
    }
    const t = targetFromModel(spec);
    return t.ok ? { ok: true, local: true, fingerprint: t.fingerprint } : t;
  }
  if (spec.queryPrefix !== undefined || spec.passagePrefix !== undefined) {
    return { ok: false, probe: refuseTarget("target-identity-invalid", "query and passage prefixes apply to local models only") };
  }
  const block: Record<string, unknown> = {
    provider: spec.provider, model: spec.model,
    ...(spec.dimensions !== undefined ? { dimensions: spec.dimensions } : {}),
    ...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
    ...(spec.apiKeyEnv !== undefined ? { apiKeyEnv: spec.apiKeyEnv } : {}),
  };
  const { privacyAck, ...providerPolicy } = policy;
  const plan = resolveEmbeddingProvider(block, privacyAck, providerPolicy); // throws the provider rule's RpcError
  if (plan.kind !== "remote") return { ok: false, probe: refuseTarget("target-identity-invalid", "the target provider could not be resolved") };
  let fingerprint: EmbeddingFingerprint;
  try {
    const n = normalizeEmbeddingConfig(plan.block);
    fingerprint = embeddingFingerprintFromNormalizedConfig({ ...n, dimensions: n.dimensions }) as unknown as EmbeddingFingerprint;
  } catch (e) {
    return { ok: false, probe: refuseTarget("target-identity-invalid", `the engine does not accept this target embedding (${(e instanceof Error ? e.message : String(e)).slice(0, 200)})`) };
  }
  const apiKeyEnv = plan.block.apiKeyEnv as string;
  return { ok: true, local: false, fingerprint, apiKeyEnv, secretRef: { source: "env", provider: "default", id: apiKeyEnv }, block: plan.block };
}

/** The provider block of a planned cloud target (for the run-time re-check and the switch): the endpoint as configured. */
export function blockFromFingerprint(fp: EmbeddingFingerprint, remote: { apiKeyEnv: string; baseUrl?: string }): Record<string, unknown> {
  const baseUrl = remote.baseUrl ?? fp.endpoint;
  return { provider: fp.provider, model: fp.model, dimensions: fp.dimensions, ...(baseUrl ? { baseUrl } : {}), apiKeyEnv: remote.apiKeyEnv };
}

/** The remote fields of a checkpoint's target as a TargetSpec fragment (empty for a local target). */
export function blockRemote(c: { target: EmbeddingFingerprint; remote?: { apiKeyEnv: string; baseUrl?: string } }): Pick<TargetSpec, "baseUrl" | "apiKeyEnv"> {
  if (!c.remote) return {};
  const baseUrl = c.remote.baseUrl ?? c.target.endpoint;
  return { apiKeyEnv: c.remote.apiKeyEnv, ...(baseUrl ? { baseUrl } : {}) };
}

/** The live rules a target is checked against: the shared engine stays local while the installation or any agent is local-only. */
export function reembedTargetPolicy(cfg: unknown): TargetPolicy {
  const memory = (cfg as { memory?: { embedding?: { privacyAck?: PrivacyAcknowledgment } } } | null)?.memory;
  return { localOnly: localOnlyShared(cfg), localEndpoints: localEndpoints(cfg), ...(memory?.embedding?.privacyAck ? { privacyAck: memory.embedding.privacyAck } : {}) };
}
