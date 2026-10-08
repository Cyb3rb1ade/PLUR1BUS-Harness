// Build the enabled cloud providers from voice.providers.* and run discovery over them (the D42 hook).
// Cloud is off until a key is set: a provider is registered only when `enabled` is true AND it has a secret reference
// (Polly: the AWS default credential chain needs no reference, so `enabled` alone is enough).
import { isVoiceProviderError } from "./errors.ts";
import { createElevenLabs } from "./providers/elevenlabs.ts";
import { createGeminiLive } from "./providers/gemini.ts";
import { createGrokVoice } from "./providers/grok.ts";
import { createPolly, type PollyClientLike } from "./providers/polly.ts";
import type { CloudDeps } from "./providers/common.ts";
import type { AsrProvider, ModelInfo, RealtimeProvider, TtsProvider, VoiceInfo } from "./types.ts";

export const CLOUD_PROVIDER_IDS = ["elevenlabs", "xai", "gemini", "polly"] as const;
export type CloudProviderId = (typeof CLOUD_PROVIDER_IDS)[number];

interface Common { enabled?: boolean; baseUrl?: string; defaultVoice?: string; defaultModel?: string }
export interface VoiceProvidersConfig {
  elevenlabs?: Common & { apiKeyRef?: string; region?: string; defaultSttModel?: string; zeroRetention?: boolean };
  xai?: Common & { apiKeyRef?: string };
  gemini?: Common & { apiKeyRef?: string };
  polly?: { enabled?: boolean; region?: string; credentials?: { profile?: string }; defaultVoice?: string; defaultModel?: string };
}

export interface ProviderStatus {
  id: CloudProviderId;
  state: "disabled" | "missing_key" | "ready";
  capabilities: Array<"asr" | "tts" | "realtime">;
}
export interface VoiceRegistry {
  asr: Partial<Record<CloudProviderId, AsrProvider>>;
  tts: Partial<Record<CloudProviderId, TtsProvider>>;
  realtime: Partial<Record<CloudProviderId, RealtimeProvider>>;
  status: ProviderStatus[];
}

export interface RegistryDeps extends CloudDeps {
  /** Test seam / host client for Polly. */
  pollyClientFactory?: () => Promise<PollyClientLike>;
}

const CAPS: Record<CloudProviderId, ProviderStatus["capabilities"]> = { elevenlabs: ["asr", "tts"], xai: ["realtime"], gemini: ["realtime"], polly: ["tts"] };

export function createVoiceProviders(config: VoiceProvidersConfig | undefined, deps: RegistryDeps): VoiceRegistry {
  const reg: VoiceRegistry = { asr: {}, tts: {}, realtime: {}, status: [] };
  const c = config ?? {};
  const add = (id: CloudProviderId, state: ProviderStatus["state"]) => reg.status.push({ id, state, capabilities: CAPS[id] });

  const el = c.elevenlabs;
  if (!el?.enabled) add("elevenlabs", "disabled");
  else if (!el.apiKeyRef) add("elevenlabs", "missing_key");
  else {
    const p = createElevenLabs({ ...deps, apiKeyRef: el.apiKeyRef, ...(el.baseUrl ? { baseUrl: el.baseUrl } : {}), ...(el.region ? { region: el.region } : {}), ...(el.defaultVoice ? { defaultVoice: el.defaultVoice } : {}), ...(el.defaultModel ? { defaultModel: el.defaultModel } : {}), ...(el.defaultSttModel ? { defaultSttModel: el.defaultSttModel } : {}), ...(el.zeroRetention !== undefined ? { zeroRetention: el.zeroRetention } : {}) });
    reg.tts.elevenlabs = p.tts;
    reg.asr.elevenlabs = p.asr;
    add("elevenlabs", "ready");
  }
  const x = c.xai;
  if (!x?.enabled) add("xai", "disabled");
  else if (!x.apiKeyRef) add("xai", "missing_key");
  else {
    reg.realtime.xai = createGrokVoice({ ...deps, apiKeyRef: x.apiKeyRef, ...(x.baseUrl ? { baseUrl: x.baseUrl } : {}), ...(x.defaultModel ? { defaultModel: x.defaultModel } : {}), ...(x.defaultVoice ? { defaultVoice: x.defaultVoice } : {}) });
    add("xai", "ready");
  }
  const g = c.gemini;
  if (!g?.enabled) add("gemini", "disabled");
  else if (!g.apiKeyRef) add("gemini", "missing_key");
  else {
    reg.realtime.gemini = createGeminiLive({ ...deps, apiKeyRef: g.apiKeyRef, ...(g.baseUrl ? { baseUrl: g.baseUrl } : {}), ...(g.defaultModel ? { defaultModel: g.defaultModel } : {}), ...(g.defaultVoice ? { defaultVoice: g.defaultVoice } : {}) });
    add("gemini", "ready");
  }
  const po = c.polly;
  if (!po?.enabled) add("polly", "disabled");
  else {
    reg.tts.polly = createPolly({ ...(deps.usage ? { usage: deps.usage } : {}), ...(deps.logger ? { logger: deps.logger } : {}), ...(po.region ? { region: po.region } : {}), ...(po.credentials?.profile ? { profile: po.credentials.profile } : {}), ...(po.defaultVoice ? { defaultVoice: po.defaultVoice } : {}), ...(po.defaultModel ? { defaultModel: po.defaultModel } : {}), ...(deps.pollyClientFactory ? { clientFactory: deps.pollyClientFactory } : {}) });
    add("polly", "ready");
  }
  return reg;
}

export interface DiscoveryResult {
  models: Array<ModelInfo & { provider: string; kind: "asr" | "tts" | "realtime" }>;
  voices: Array<VoiceInfo & { provider: string }>;
  /** Providers whose discovery failed, with the unified error code (never the vendor text). */
  errors: Array<{ provider: string; kind: string; code: string }>;
}

/** Ask every registered provider what it offers now. One provider failing does not hide the others. */
export async function discover(reg: VoiceRegistry, signal?: AbortSignal): Promise<DiscoveryResult> {
  const out: DiscoveryResult = { models: [], voices: [], errors: [] };
  const opt = signal ? { signal } : {};
  const run = async (provider: string, kind: "asr" | "tts" | "realtime", fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { out.errors.push({ provider, kind, code: isVoiceProviderError(e) ? e.code : "network" }); }
  };
  for (const [id, p] of Object.entries(reg.tts) as Array<[string, TtsProvider]>) {
    await run(id, "tts", async () => { for (const m of await p.listModels(opt)) out.models.push({ ...m, provider: id, kind: "tts" }); });
    await run(id, "tts", async () => { for (const v of await p.listVoices(opt)) out.voices.push({ ...v, provider: id }); });
  }
  for (const [id, p] of Object.entries(reg.asr) as Array<[string, AsrProvider]>) await run(id, "asr", async () => { for (const m of await p.listModels(opt)) out.models.push({ ...m, provider: id, kind: "asr" }); });
  for (const [id, p] of Object.entries(reg.realtime) as Array<[string, RealtimeProvider]>) await run(id, "realtime", async () => { for (const m of await p.listModels(opt)) out.models.push({ ...m, provider: id, kind: "realtime" }); });
  return out;
}
