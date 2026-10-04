// D112 model discovery: the catalog's vocabulary and file shape (spec §2.5, §2.6; plan Task 1).

export const MODEL_KINDS = ["chat", "embedding", "tts", "asr", "image", "moderation", "rerank", "realtime", "unknown"] as const;
export const CAPABILITIES = ["tools", "vision", "reasoning", "audio_in", "audio_out", "structured_output", "prompt_caching"] as const;
export const DISCOVERY_KINDS = ["openai-models", "anthropic-models", "google-models", "ollama-tags", "manual"] as const;
export type ModelKind = typeof MODEL_KINDS[number];
export type Capability = typeof CAPABILITIES[number];
export type DiscoveryKind = typeof DISCOVERY_KINDS[number];
export type ModelStatus = "available" | "unavailable" | "manual";
export type ModelSource = "scan" | "table" | "manual";
export type ScanResultCode = "ok" | "failed:auth" | "failed:network" | "failed:server" | "failed:invalid" | "failed:empty";
export type ScanOutcomeCode = ScanResultCode | "already_running" | "disabled" | "no-scanner";
export type RunTrigger = "cron" | "manual" | "harness";

export interface ModelOverrides { displayName?: string; kind?: ModelKind; contextWindow?: number; capabilities?: Capability[]; aliases?: string[] }
export interface ApiFields { displayName?: string; kind?: ModelKind; contextWindow?: number; capabilities?: Capability[] }
export interface RawEntry extends ApiFields { id: string; created?: number /* epoch ms */ }
export interface CatalogModel {
  provider: string; id: string; displayName: string; kind: ModelKind; contextWindow?: number; capabilities: Capability[]; aliases: string[];
  status: ModelStatus; firstSeen: string; lastSeen: string; source: ModelSource; overrides: ModelOverrides; api?: ApiFields;
}
export interface ProviderScanState { lastScanAt?: string; lastResult?: ScanResultCode; nextScanAt?: string; consecutiveFailures?: number }
export interface CatalogFile {
  schema: "plur1bus.model-catalog/1"; revision: number; tableRevision: string; acknowledgedAt?: string;
  providers: Record<string, ProviderScanState>; models: CatalogModel[];
}
export type ScanWarning =
  | { code: "role_unavailable"; role: string; provider: string; id: string }
  | { code: "shadowed_by_manual"; provider: string; id: string }
  | { code: "empty_list"; provider: string };
export interface ScanErrorInfo {
  code: "auth" | "network" | "timeout" | "server" | "rate-limited" | "invalid-request"; reason: string; retryable: boolean; hint: string;
  httpStatus?: number; retryAfterS?: number;
}

/** A catalog with revision 0, no providers and no models. */
export function emptyCatalog(tableRevision: string): CatalogFile {
  return { schema: "plur1bus.model-catalog/1", revision: 0, tableRevision, providers: {}, models: [] };
}
