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
/**
 * Resampler for the 16/24 kHz pairs this package deals with. Downsampling low-passes first (Hamming-windowed sinc,
 * cutoff 0.45 x the target rate, 32 taps per input-rate/target-rate ratio) so energy above the new Nyquist does not
 * alias into the speech band; upsampling is linear interpolation. Weights are normalised per output sample, so DC and
 * the edges keep their level.
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const n = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(n);
  const ratio = from / to;
  if (to >= from) {
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, samples.length - 1);
      out[i] = samples[i0]! + (samples[i1]! - samples[i0]!) * (pos - i0);
    }
    return out;
  }
  const half = Math.ceil(16 * ratio);
  const fc = (0.45 * to) / from; // cycles per input sample
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const c = Math.floor(pos);
    let acc = 0;
    let wsum = 0;
    for (let j = Math.max(0, c - half + 1); j <= Math.min(samples.length - 1, c + half); j++) {
      const t = j - pos;
      const x = 2 * Math.PI * fc * t;
      const sinc = t === 0 ? 1 : Math.sin(x) / x;
      const w = sinc * (0.54 + 0.46 * Math.cos((Math.PI * t) / half));
      acc += samples[j]! * w;
      wsum += w;
    }
    out[i] = wsum === 0 ? 0 : acc / wsum;
  }
  return out;
}

const ID = "local";
const REC_RATE = 16000;

/** What an adapter call holds while it uses a loaded model; `release()` must run exactly when the call, stream or session is over. */
export interface AsrLease { asr: LoadedAsr; model: CatalogModel; release(): void }
export interface TtsLease { tts: LoadedTts; model: CatalogModel; release(): void }

/** A model with a fixed language refuses a request for another one (multi-language models accept any). */
function assertLanguage(model: CatalogModel, requested: string | undefined): void {
  if (!requested || !model.language || model.language === "multi") return;
  const primary = (c: string) => c.toLowerCase().split(/[-_]/)[0];
  if (primary(requested) !== primary(model.language)) throw new VoiceProviderError("unsupported", `local: ${model.displayName} recognises ${model.language}, not ${requested}`, { provider: ID });
}

/**
 * Note: a streaming recogniser decodes synchronously inside `sendAudio`, on the event loop; the offline path is
 * asynchronous. `options.language` is checked against the model's fixed language only: sherpa-onnx offers no
 * per-request language switch for a multi-language model here, so it is not passed through.
 */
export function createLocalAsr(get: () => AsrLease, onUsage?: (r: UsageReport) => void): AsrProvider {
  return {
    id: ID,
    kind: "asr",
    async transcribe(audio, options: TranscribeOptions = {}): Promise<TranscriptResult> {
      if (options.signal?.aborted) throw abortedError(ID);
      if (audio.format !== "pcm16") throw new VoiceProviderError("unsupported", "local: transcribe takes pcm16 input", { provider: ID });
      const { asr, model, release } = get();
      let text: string;
      try {
        assertLanguage(model, options.language);
        const samples = pcm16ToFloat32(audio.data);
        if (asr.streaming) {
          const st = asr.createStream();
          try { st.acceptWaveform(samples, audio.sampleRate); text = st.finish().text; } finally { st.dispose(); }
        } else text = (await asr.decodeOffline(samples, audio.sampleRate)).text;
      } finally { release(); }
      const usage: UsageReport = { provider: ID, operation: "asr", model: model.id, seconds: pcm16Seconds(audio.data.byteLength, audio.sampleRate) };
      onUsage?.(usage);
      return { text, ...(model.language && model.language !== "multi" ? { language: model.language } : {}), usage };
    },

    async openStream(options: AsrStreamOptions = {}): Promise<AsrSession> {
      const { asr, model, release } = get();
      const rate = options.sampleRate ?? REC_RATE;
      const q = new AsyncQueue<AsrEvent>();
      let closed = false;
      let lastPartial = "";
      const buffered: Uint8Array[] = [];
      let st: ReturnType<LoadedAsr["createStream"]> | undefined;
      try {
        assertLanguage(model, options.language);
        st = asr.streaming ? asr.createStream() : undefined;
      } catch (e) { release(); throw e; }
      // The lease lives as long as the session: a language switch retires the models, but they are freed only after close().
      let pendingDecodes = 0;
      let leaseHeld = true;
      const maybeRelease = () => { if (leaseHeld && closed && pendingDecodes === 0) { leaseHeld = false; release(); } };
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
          pendingDecodes++;
          void asr.decodeOffline(pcm16ToFloat32(all), rate).then((r) => emitFinal(r.text), (e) => q.push({ type: "error", error: e as Error })).finally(() => { pendingDecodes--; maybeRelease(); });
        },
        async close() {
          if (closed) return;
          closed = true;
          st?.dispose();
          q.push({ type: "closed" });
          q.end();
          maybeRelease();
        },
      };
      return session;
    },

    async listModels(): Promise<ModelInfo[]> {
      const { model, release } = get();
      release();
      return [{ id: model.id, name: model.displayName, capabilities: ["asr", ...(model.streaming ? ["streaming"] : [])], ...(model.language && model.language !== "multi" ? { languages: [model.language] } : {}) }];
    },
  };
}

export function createLocalTts(get: () => TtsLease, onUsage?: (r: UsageReport) => void, maxWords?: number): TtsProvider {
  function speakerOf(model: CatalogModel, voice: string | undefined): number {
    if (voice === undefined) return model.speakers ? (model.speakers[model.defaultSpeaker ?? ""] ?? 0) : 0;
    if (model.speakers && voice in model.speakers) return model.speakers[voice]!;
    if (/^\d+$/.test(voice)) return Number(voice);
    throw new VoiceProviderError("invalid_request", `local: unknown voice "${voice}" for ${model.displayName}`, { provider: ID });
  }
  async function one(text: string, options: TtsOptions, held: { tts: LoadedTts; model: CatalogModel }): Promise<AudioChunk> {
    if (options.signal?.aborted) throw abortedError(ID);
    const { tts, model } = held;
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
      const lease = get();
      try {
        const a = await one(text, options, lease);
        const usage: UsageReport = { provider: ID, operation: "tts", model: lease.model.id, chars: text.length };
        onUsage?.(usage);
        return { ...a, usage };
      } finally { lease.release(); }
    },
    async *synthesizeStream(input, options = {}) {
      let chars = 0;
      // One lease for the whole stream: the voice stays the same and survives a language switch until the stream ends.
      const lease = get();
      try {
        yield* chunkedSynthesis((async function* () { for await (const c of textChunks(input)) { chars += c.length; yield c; } })(), async (s) => [await one(s, options, lease)], maxWords);
        onUsage?.({ provider: ID, operation: "tts", model: lease.model.id, chars });
      } finally { lease.release(); }
    },
    async listVoices(): Promise<VoiceInfo[]> {
      const { model, release } = get();
      release();
      const lang = model.language && model.language !== "multi" ? [model.language] : undefined;
      if (model.speakers) return Object.keys(model.speakers).map((name) => ({ id: name, name, ...(lang ? { languages: lang } : {}) }));
      return [{ id: "0", name: model.displayName, ...(lang ? { languages: lang } : {}) }];
    },
    async listModels(): Promise<ModelInfo[]> {
      const { model, release } = get();
      release();
      return [{ id: model.id, name: model.displayName, capabilities: ["tts"] }];
    },
  };
  return self;
}
