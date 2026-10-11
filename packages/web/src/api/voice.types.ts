// Voice V3 wire types come from the RPC schema. Type-only imports keep Node-only schema code out of the browser.
export type {
  VoiceProfileName, VoiceModel, VoiceProfileModels, VoiceLanguage,
  VoiceLanguageListParams, VoiceLanguageListResult, VoiceLanguageGetParams, VoiceLanguageGetResult,
  VoiceLanguageSetParams, VoiceLanguageSetResult, VoiceDownloadProgress,
  VoiceFeatureName, VoiceFeatureMode, VoiceFeatureEffective, VoiceFeatureSetting, VoiceFeatureState,
  VoiceRealtimeProfile, VoiceRealtimeProfileInput, VoiceMetricsGetParams, VoiceMetrics, VoiceErrorCode,
  VoiceRealtimeProfileGetParams as VoiceProfileGetParams,
  VoiceRealtimeProfileSetParams as VoiceProfileSetParams,
} from '../../../rpc-schema/generated/types.ts';
import type { VoiceProfileName, VoiceFeatureName, VoiceModel, VoiceMetrics, VoiceErrorCode } from '../../../rpc-schema/generated/types.ts';
export type VoiceModelRole = VoiceModel['role'];
export type VoiceLatency = VoiceMetrics['speechEndToFirstAudio'];
export const VOICE_PROFILES = ['fast', 'quality'] as const satisfies readonly VoiceProfileName[];
export const VOICE_FEATURES = ['autoRecall', 'promptEnrichment', 'reranker', 'decisionService', 'postTurnRefine', 'memoryWrite', 'compaction', 'toolSchemas'] as const satisfies readonly VoiceFeatureName[];
export const VOICE_ERROR_CODES = ['E_VOICE_LICENCE', 'E_VOICE_LICENSE', 'E_VOICE_BUDGET', 'E_VOICE_UNAVAILABLE'] as const satisfies readonly VoiceErrorCode[];
import type * as Wire from '../../../rpc-schema/generated/types.ts';
declare module './index.ts' {
  interface RpcMethods {
    'voice.language.list': { params: Wire.VoiceLanguageListParams | undefined; result: Wire.VoiceLanguageListResult };
    'voice.language.get': { params: Wire.VoiceLanguageGetParams | undefined; result: Wire.VoiceLanguageGetResult };
    'voice.language.set': { params: Wire.VoiceLanguageSetParams; result: Wire.VoiceLanguageSetResult };
    'voice.realtime.profile.get': { params: Wire.VoiceRealtimeProfileGetParams | undefined; result: Wire.VoiceRealtimeProfileGetResult };
    'voice.realtime.profile.set': { params: Wire.VoiceRealtimeProfileSetParams; result: Wire.VoiceRealtimeProfileSetResult };
    'voice.metrics.get': { params: Wire.VoiceMetricsGetParams | undefined; result: Wire.VoiceMetricsGetResult };
  }
}
