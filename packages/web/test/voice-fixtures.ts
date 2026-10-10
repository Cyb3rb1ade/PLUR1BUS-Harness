// Mock /rpc for the voice page tests (V3 contract): voice.language.list|get|set, voice.realtime.profile.get|set, voice.metrics.get,
// plus helpers to push `voice.download.progress`. Nothing here touches the network.
import { rpcError, type MockRpc } from "./mock-rpc.ts";
import type { MockHarnessServer } from "./mock-server.ts";
import type { VoiceFeatureName, VoiceLanguage, VoiceMetrics, VoiceModel, VoiceRealtimeProfile } from "../src/api/voice.types.ts";
import { VOICE_FEATURES } from "../src/api/voice.types.ts";

export const MB = 1024 * 1024;

export const LANGUAGES = (installed: string[] = []): VoiceLanguage[] => {
  const m = (modelId: string, role: "asr" | "tts" | "vad", mb: number, licenceId: string, needsConfirmation: boolean): VoiceModel =>
    ({ modelId, role, sizeBytes: mb * MB, licenceId, needsConfirmation, installed: installed.includes(modelId) });
  return [
    { language: "de", profiles: {
      fast: { models: [m("kroko-de", "asr", 120, "CC-BY-SA-4.0", true), m("piper-de-thorsten", "tts", 60, "CC0-1.0", false), m("silero-vad", "vad", 2, "MIT", false)] },
      quality: { models: [m("whisper-de", "asr", 800, "MIT", false), m("piper-de-thorsten", "tts", 60, "CC0-1.0", false), m("silero-vad", "vad", 2, "MIT", false)] },
    } },
    { language: "en", profiles: {
      fast: { models: [m("zipformer-en", "asr", 80, "Apache-2.0", false), m("piper-en-lessac", "tts", 60, "blizzard-2013", true), m("silero-vad", "vad", 2, "MIT", false)] },
      quality: { models: [m("whisper-en", "asr", 600, "MIT", false), m("kokoro-en", "tts", 330, "Apache-2.0", false), m("silero-vad", "vad", 2, "MIT", false)] },
    } },
    { language: "fr", profiles: { fast: { models: [m("zipformer-fr", "asr", 70, "Apache-2.0", false), m("piper-fr-siwis", "tts", 60, "CC-BY-NC-4.0", true)] } } },
  ];
};

export const profileOf = (over: Partial<VoiceRealtimeProfile> = {}): VoiceRealtimeProfile => {
  const features = {} as VoiceRealtimeProfile["features"];
  for (const f of VOICE_FEATURES) features[f] = { mode: "on", effective: "applied" };
  features.postTurnRefine = { mode: "deferred", maxMs: 400, effective: "applied" };
  features.memoryWrite = { mode: "deferred", effective: "engine-fixed" };
  features.toolSchemas = { mode: "reduced", maxMs: 50, effective: "applied" };
  return { enabled: true, endpointingMs: 700, speculative: false, ackSound: true, features, ...over };
};

export const METRICS: VoiceMetrics = {
  speechEndToFirstAudio: { medianMs: 820, p95Ms: 1340, samples: 42 },
  featureCost: { autoRecall: { medianMs: 120, p95Ms: 260 }, reranker: { medianMs: 90, p95Ms: 150 }, toolSchemas: { medianMs: 5, p95Ms: 9 } } as VoiceMetrics["featureCost"],
  windowSec: 3600,
};

export type VoiceWorld = {
  languages: VoiceLanguage[];
  current: { language: string; profile: "fast" | "quality" };
  profile: VoiceRealtimeProfile;
  /** Per-agent profiles by agent id (absent = inherits the global one). */
  agents: Record<string, VoiceRealtimeProfile>;
  metrics: VoiceMetrics | null;
  /** Whether `voice.language.set` starts a download. */
  downloading: boolean;
};

export const voiceWorld = (over: Partial<VoiceWorld> = {}): VoiceWorld => ({
  languages: LANGUAGES(), current: { language: "de", profile: "fast" }, profile: profileOf(), agents: {}, metrics: METRICS, downloading: true, ...over,
});

const agentOf = (p: unknown): string | undefined => (p as { agentId?: string } | undefined)?.agentId;

export function installVoice(server: MockHarnessServer | { rpc: MockRpc; events?: { enable(): void } } | MockRpc, w: VoiceWorld = voiceWorld()): VoiceWorld {
  const rpc = "rpc" in server ? server.rpc : server;
  if ("events" in server && server.events) server.events.enable();
  rpc.handle("voice.language.list", () => ({ languages: w.languages }), { write: false });
  rpc.handle("voice.language.get", () => w.current, { write: false });
  rpc.handle("voice.language.set", (p: unknown) => {
    const q = p as { language: string; profile: "fast" | "quality"; acceptLicences?: string[] };
    const models = w.languages.find((l) => l.language === q.language)?.profiles[q.profile]?.models;
    if (!models) throw rpcError("E_INVALID_PARAMS", "unknown language or profile");
    for (const m of models) if (m.needsConfirmation && !m.installed && !(q.acceptLicences ?? []).includes(`${m.modelId}@${m.licenceId}`)) throw rpcError("E_VOICE_LICENCE", "licence not confirmed");
    w.current = { language: q.language, profile: q.profile };
    return { ok: true, downloading: w.downloading };
  });
  rpc.handle("voice.realtime.profile.get", (p: unknown) => { const a = agentOf(p); return (a !== undefined ? w.agents[a] : undefined) ?? w.profile; }, { write: false });
  rpc.handle("voice.realtime.profile.set", (p: unknown) => {
    const q = p as { agentId?: string } & Omit<VoiceRealtimeProfile, "features"> & { features: Record<VoiceFeatureName, { mode: string; maxMs?: number }> };
    const next = profileOf({ enabled: q.enabled, endpointingMs: q.endpointingMs, speculative: q.speculative, ackSound: q.ackSound });
    for (const f of VOICE_FEATURES) {
      next.features[f] = { mode: q.features[f].mode as never, ...(q.features[f].maxMs !== undefined ? { maxMs: q.features[f].maxMs } : {}), effective: f === "memoryWrite" ? "engine-fixed" : "applied" };
    }
    if (q.agentId !== undefined) w.agents[q.agentId] = next; else w.profile = next;
    return next;
  });
  if (w.metrics) rpc.handle("voice.metrics.get", () => w.metrics, { write: false });
  return w;
}

/** The SSE event the backend sends while a model downloads. */
export function pushProgress(server: MockHarnessServer, modelId: string, receivedBytes: number, totalBytes: number, done = false, error?: string): void {
  server.events.push({ event: "voice.download.progress", data: { modelId, receivedBytes, totalBytes, done, ...(error !== undefined ? { error } : {}) } });
}

export const voiceCalls = (server: MockHarnessServer, method: string): { params: unknown }[] => server.rpc.calls.filter((c) => c.method === method) as never;
