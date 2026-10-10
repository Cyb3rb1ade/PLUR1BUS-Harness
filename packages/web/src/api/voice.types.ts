// Voice wire types (V3), transcribed from the binding contract of the "V3 backend" PR: the RPC methods `voice.language.list|get|set`,
// `voice.realtime.profile.get|set`, `voice.metrics.get`, the SSE event `voice.download.progress` and the error codes `E_VOICE_*`.
// Follow-up: replace this file by the generated RPC types (packages/rpc-schema) as soon as the backend PR has landed them.
// Like the other browser-side type files it must not import the schema package (it pulls in Node-only code).

export type VoiceProfileName = "fast" | "quality";
export const VOICE_PROFILES: readonly VoiceProfileName[] = ["fast", "quality"];
export type VoiceModelRole = "asr" | "tts" | "vad";

export type VoiceModel = {
  modelId: string;
  role: VoiceModelRole;
  sizeBytes: number;
  licenceId: string;
  needsConfirmation: boolean;
  installed: boolean;
};
export type VoiceProfileModels = { models: VoiceModel[] };
export type VoiceLanguage = { language: string; profiles: Partial<Record<VoiceProfileName, VoiceProfileModels>> };

export type VoiceLanguageListParams = { agentId?: string };
export type VoiceLanguageListResult = { languages: VoiceLanguage[] };
export type VoiceLanguageGetParams = { agentId?: string };
export type VoiceLanguageGetResult = { language: string; profile: VoiceProfileName };
/** `acceptLicences` entries are `"modelId@licenceId"`. */
export type VoiceLanguageSetParams = { language: string; profile: VoiceProfileName; acceptLicences?: string[]; agentId?: string };
export type VoiceLanguageSetResult = { ok: true; downloading: boolean };

/** Payload of the SSE event `voice.download.progress`. */
export type VoiceDownloadProgress = { modelId: string; receivedBytes: number; totalBytes: number; done: boolean; error?: string };

export type VoiceFeatureName = "autoRecall" | "promptEnrichment" | "reranker" | "decisionService" | "postTurnRefine" | "memoryWrite" | "compaction" | "toolSchemas";
export const VOICE_FEATURES: readonly VoiceFeatureName[] = ["autoRecall", "promptEnrichment", "reranker", "decisionService", "postTurnRefine", "memoryWrite", "compaction", "toolSchemas"];
export type VoiceFeatureMode = "on" | "deferred" | "off" | "reduced";
export type VoiceFeatureEffective = "applied" | "engine-fixed";

export type VoiceFeatureSetting = { mode: VoiceFeatureMode; maxMs?: number };
export type VoiceFeatureState = VoiceFeatureSetting & { effective: VoiceFeatureEffective };

export type VoiceRealtimeProfile = {
  enabled: boolean;
  endpointingMs: number;
  speculative: boolean;
  ackSound: boolean;
  features: Record<VoiceFeatureName, VoiceFeatureState>;
};
/** What `voice.realtime.profile.set` takes: the same fields without `effective`. */
export type VoiceRealtimeProfileInput = {
  enabled: boolean;
  endpointingMs: number;
  speculative: boolean;
  ackSound: boolean;
  features: Record<VoiceFeatureName, VoiceFeatureSetting>;
};
export type VoiceProfileGetParams = { agentId?: string };
export type VoiceProfileSetParams = VoiceRealtimeProfileInput & { agentId?: string };

export type VoiceMetricsGetParams = { agentId?: string };
export type VoiceLatency = { medianMs: number; p95Ms: number };
export type VoiceMetrics = {
  speechEndToFirstAudio: VoiceLatency & { samples: number };
  featureCost: Partial<Record<string, VoiceLatency>>;
  windowSec: number;
};

export const VOICE_ERROR_CODES = ["E_VOICE_LICENCE", "E_VOICE_UNAVAILABLE"] as const;
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];

declare module "./index.ts" {
  interface RpcMethods {
    "voice.language.list": { params: VoiceLanguageListParams | undefined; result: VoiceLanguageListResult };
    "voice.language.get": { params: VoiceLanguageGetParams | undefined; result: VoiceLanguageGetResult };
    "voice.language.set": { params: VoiceLanguageSetParams; result: VoiceLanguageSetResult };
    "voice.realtime.profile.get": { params: VoiceProfileGetParams | undefined; result: VoiceRealtimeProfile };
    "voice.realtime.profile.set": { params: VoiceProfileSetParams; result: VoiceRealtimeProfile };
    "voice.metrics.get": { params: VoiceMetricsGetParams | undefined; result: VoiceMetrics };
  }
}
