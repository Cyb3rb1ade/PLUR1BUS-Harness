// Wire types of the models.* RPC (docs/rpc.md, spec 2026-10-03-model-discovery-design.md), merged into the typed client.
// These are the DOCUMENTED shapes; nothing here is served by origin/main yet (only REST session/csrf/health/whoami/agents).

export type ModelKind = "chat" | "embedding" | "tts" | "asr" | "image" | "moderation" | "rerank" | "realtime" | "unknown";
export type ModelCapability = "tools" | "vision" | "reasoning" | "audio_in" | "audio_out" | "structured_output" | "prompt_caching";
export type CatalogModelStatus = "available" | "unavailable" | "manual";
export type ModelSource = "scan" | "table" | "manual";

export type ModelOverrides = {
  displayName?: string;
  kind?: ModelKind;
  contextWindow?: number;
  capabilities?: ModelCapability[];
  aliases?: string[];
};

export type ModelEntry = {
  provider: string;
  id: string;
  displayName: string;
  kind: ModelKind;
  contextWindow?: number;
  capabilities: ModelCapability[];
  aliases: string[];
  status: CatalogModelStatus;
  firstSeen: string;
  lastSeen: string;
  source: ModelSource;
  overrides: ModelOverrides;
};

export type ModelScanResultCode = "ok" | "failed:auth" | "failed:network" | "failed:server" | "failed:invalid" | "failed:empty";
export type ModelScanOutcomeCode = ModelScanResultCode | "already_running" | "disabled" | "no-scanner";

export type ModelProviderState = { provider: string; lastScanAt?: string; lastResult?: ModelScanResultCode; nextScanAt?: string; consecutiveFailures?: number };
export type ModelScanWarning = { code: "role_unavailable" | "shadowed_by_manual" | "empty_list"; role?: string; provider?: string; id?: string };

export type ModelsListResult = { models: ModelEntry[]; providers: ModelProviderState[]; newCount: number; warnings: ModelScanWarning[] };

export type ModelScanProviderResult = {
  provider: string;
  result: ModelScanOutcomeCode;
  runningRunId?: string;
  new: string[];
  reappeared: string[];
  unavailable: string[];
  unchanged: number;
  duplicates: number;
  warnings: ModelScanWarning[];
  nextScanAt: string | null;
  error?: { code: string; reason: string; retryable: boolean; hint: string; httpStatus?: number; retryAfterS?: number };
};
export type ModelsScanResult = { startedAt: string; finishedAt: string; providers: ModelScanProviderResult[] };

export type OverrideField = "displayName" | "kind" | "contextWindow" | "capabilities" | "aliases";

declare module "../../api/client.ts" {
  interface RpcMethods {
    "models.list": { params: { provider?: string; kind?: ModelKind; status?: CatalogModelStatus; newOnly?: boolean } | undefined; result: ModelsListResult };
    "models.scan": { params: { provider?: string } | undefined; result: ModelsScanResult };
    "models.setOverride": { params: { provider: string; id: string; set?: ModelOverrides; clear?: OverrideField[] | "all"; create?: boolean }; result: ModelEntry };
    "models.removeManual": { params: { provider: string; id: string }; result: { removed: boolean } };
    "models.acknowledge": { params: undefined; result: { acknowledgedAt: string } };
  }
}
