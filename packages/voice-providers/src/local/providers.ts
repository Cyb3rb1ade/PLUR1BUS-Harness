// AsrProvider / TtsProvider adapters over a loaded local model. They share the unified interfaces with the cloud
// providers, so the voice path does not care which side answered.
import { VoiceProviderError, abortedError } from "../errors.ts";
import { chunkedSynthesis } from "../providers/common.ts";
import type { AsrEvent, AsrProvider, AsrSession, AsrStreamOptions, AudioChunk, ModelInfo, TranscribeOptions, TranscriptResult, TtsOptions, TtsProvider, UsageReport, VoiceInfo } from "../types.ts";
import { AsyncQueue, concatBytes, pcm16Seconds, textChunks } from "../util.ts";
import type { CatalogModel } from "./catalog.ts";
import type { LoadedAsr, LoadedTts } from "./engine.ts";

export function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
  const n = Math.floor(pcm.byteLength / 2);
  const v = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true) / 32768;
  return out;
}
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) v.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), true);
  return out;
}
/** Linear resampler; fine for speech at the 16/24 kHz pairs this package deals with. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const n = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    out[i] = samples[i0]! + (samples[i1]! - samples[i0]!) * (pos - i0);
  }
  return out;
}

const ID = "local";
const REC_RATE = 16000;

export function createLocalAsr(
  get: () => { asr: LoadedAsr; model: CatalogModel },
  onUsage?: (r: UsageReport) => void,
  hooks?: { onStreamOpen?: (asr: LoadedAsr) => () => void },
): AsrProvider {
  return {
    id: ID,
    kind: "asr",
    async transcribe(audio, options: TranscribeOptions = {}): Promise<TranscriptResult> {
      if (options.signal?.aborted) throw abortedError(ID);
      if (audio.format !== "pcm16") throw new VoiceProviderError("unsupported", "local: transcribe takes pcm16 input", { provider: ID });
      const { asr, model } = get();
      const samples = pcm16ToFloat32(audio.data);
      let text: string;
      if (asr.streaming) {
        const st = asr.createStream();
        try { st.acceptWaveform(samples, audio.sampleRate); text = st.finish().text; } finally { st.dispose(); }
      } else text = (await asr.decodeOffline(samples, audio.sampleRate)).text;
      const usage: UsageReport = { provider: ID, operation: "asr", model: model.id, seconds: pcm16Seconds(audio.data.byteLength, audio.sampleRate) };
      onUsage?.(usage);
      return { text, ...(model.language && model.language !== "multi" ? { language: model.language } : {}), usage };
    },

    async openStream(options: AsrStreamOptions = {}): Promise<AsrSession> {
      const { asr } = get();
      const release = hooks?.onStreamOpen?.(asr);
      const rate = options.sampleRate ?? REC_RATE;
      const q = new AsyncQueue<AsrEvent>();
      let closed = false;
      let lastPartial = "";
      const buffered: Uint8Array[] = [];
      const st = asr.streaming ? asr.createStream() : undefined;
      q.push({ type: "ready" });
      const emitFinal = (text: string) => { if (text !== "") q.push({ type: "final", text }); lastPartial = ""; };
      const guard = () => { if (closed) throw new VoiceProviderError("closed", "local: session is closed", { provider: ID }); };
      options.signal?.addEventListener("abort", () => { q.push({ type: "error", error: abortedError(ID) }); void session.close(); }, { once: true });
      const session: AsrSession = {
        events: q,
        sendAudio(pcm) {
          guard();
          if (!st) { buffered.push(pcm); return; }
          st.acceptWaveform(pcm16ToFloat32(pcm), rate);
          const r = st.result();
          if (r.isEndpoint) { emitFinal(r.text); st.reset(); }
          else if (r.text !== "" && r.text !== lastPartial) { lastPartial = r.text; q.push({ type: "partial", text: r.text }); }
        },
        commit() {
          guard();
          if (st) { emitFinal(st.finish().text); st.reset(); return; }
          const all = concatBytes(buffered.splice(0));
          if (all.byteLength === 0) return;
          void asr.decodeOffline(pcm16ToFloat32(all), rate).then((r) => emitFinal(r.text), (e) => q.push({ type: "error", error: e as Error }));
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            st?.dispose();
          } finally {
            release?.();
          }
          q.push({ type: "closed" });
          q.end();
        },
      };
      return session;
    },

    async listModels(): Promise<ModelInfo[]> {
      const { model } = get();
      return [{ id: model.id, name: model.displayName, capabilities: ["asr", ...(model.streaming ? ["streaming"] : [])], ...(model.language && model.language !== "multi" ? { languages: [model.language] } : {}) }];
    },
  };
}

export function createLocalTts(get: () => { tts: LoadedTts; model: CatalogModel }, onUsage?: (r: UsageReport) => void, maxWords?: number): TtsProvider {
  function speakerOf(model: CatalogModel, voice: string | undefined): number {
    if (voice === undefined) return model.speakers ? (model.speakers[model.defaultSpeaker ?? ""] ?? 0) : 0;
    if (model.speakers && voice in model.speakers) return model.speakers[voice]!;
    if (/^\d+$/.test(voice)) return Number(voice);
    throw new VoiceProviderError("invalid_request", `local: unknown voice "${voice}" for ${model.displayName}`, { provider: ID });
  }
  async function one(text: string, options: TtsOptions): Promise<AudioChunk> {
    if (options.signal?.aborted) throw abortedError(ID);
    const { tts, model } = get();
    if ((options.format ?? "pcm16") !== "pcm16") throw new VoiceProviderError("unsupported", "local: only pcm16 output is offered", { provider: ID });
    const speed = typeof options.voiceSettings?.["speed"] === "number" ? options.voiceSettings["speed"] : 1;
    const r = await tts.generate(text, { speaker: speakerOf(model, options.voice), speed });
    const rate = options.sampleRate ?? r.sampleRate;
    return { data: float32ToPcm16(resample(r.samples, r.sampleRate, rate)), format: "pcm16", sampleRate: rate };
  }
  const self: TtsProvider = {
    id: ID,
    kind: "tts",
    textInputStreaming: false,
    formats: ["pcm16"],
    async synthesize(text, options = {}) {
      const a = await one(text, options);
      const usage: UsageReport = { provider: ID, operation: "tts", model: get().model.id, chars: text.length };
      onUsage?.(usage);
      return { ...a, usage };
    },
    async *synthesizeStream(input, options = {}) {
      let chars = 0;
      yield* chunkedSynthesis((async function* () { for await (const c of textChunks(input)) { chars += c.length; yield c; } })(), async (s) => [await one(s, options)], maxWords);
      onUsage?.({ provider: ID, operation: "tts", model: get().model.id, chars });
    },
    async listVoices(): Promise<VoiceInfo[]> {
      const { model } = get();
      const lang = model.language && model.language !== "multi" ? [model.language] : undefined;
      if (model.speakers) return Object.keys(model.speakers).map((name) => ({ id: name, name, ...(lang ? { languages: lang } : {}) }));
      return [{ id: "0", name: model.displayName, ...(lang ? { languages: lang } : {}) }];
    },
    async listModels(): Promise<ModelInfo[]> {
      const { model } = get();
      return [{ id: model.id, name: model.displayName, capabilities: ["tts"] }];
    },
  };
  return self;
}
