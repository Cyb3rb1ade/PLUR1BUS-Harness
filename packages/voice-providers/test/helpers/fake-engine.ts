import { createHash } from "node:crypto";
import type { Availability, LoadedAsr, LoadedTts, LoadedVad, LocalAsrStream, LocalEngine, ResolvedModel } from "../../src/local/engine.ts";

export class FakeEngine implements LocalEngine {
  avail: Availability = { ok: true };
  unsupportedEngines = new Set<string>();
  failLoad: string | undefined;
  readonly events: string[] = [];
  readonly asrStreams: string[] = [];
  availability(): Availability { return this.avail; }
  supports(_kind: "stt" | "tts" | "vad", engine: string): boolean { return !this.unsupportedEngines.has(engine); }
  async loadAsr(m: ResolvedModel): Promise<LoadedAsr> {
    if (this.failLoad === m.model.id) throw new Error("boom");
    this.events.push(`load:${m.model.id}`);
    const events = this.events;
    const streams = this.asrStreams;
    const streaming = m.model.streaming === true;
    return {
      streaming,
      createStream(): LocalAsrStream {
        streams.push(m.model.id);
        let total = 0;
        return {
          acceptWaveform: (s) => { total += s.length; },
          result: () => ({ text: total === 0 ? "" : `heard ${Math.floor(total / 160)}`, isEndpoint: total >= 3200 }),
          finish: () => ({ text: total === 0 ? "" : `final ${Math.floor(total / 160)}` }),
          reset: () => { total = 0; },
          dispose: () => {},
        };
      },
      decodeOffline: async (s) => ({ text: `offline ${s.length}` }),
      warm: async () => { events.push(`warm:asr:${m.model.id}`); },
      dispose: () => { events.push(`dispose:${m.model.id}`); },
    };
  }
  async loadTts(m: ResolvedModel): Promise<LoadedTts> {
    if (this.failLoad === m.model.id) throw new Error("boom");
    this.events.push(`load:${m.model.id}`);
    const events = this.events;
    const rate = m.model.sampleRate ?? 22050;
    const gen: LoadedTts["generate"] = async (text, o) => {
      const n = 100 * text.length;
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * (200 + (o.speaker ?? 0) * 50) * i) / rate) * 0.4;
      return { samples, sampleRate: rate };
    };
    return { sampleRate: rate, speakers: Object.keys(m.model.speakers ?? { a: 0 }).length, generate: gen, warm: async () => { events.push(`warm:tts:${m.model.id}`); }, dispose: () => { events.push(`dispose:${m.model.id}`); } };
  }
  async loadVad(m: ResolvedModel): Promise<LoadedVad> {
    this.events.push(`load:${m.model.id}`);
    const events = this.events;
    return { acceptWaveform() {}, isSpeech: () => false, reset() {}, dispose: () => { events.push(`dispose:${m.model.id}`); } };
  }
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic pseudo-model bytes. */
export function modelBytes(seed: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) { x = (x * 1664525 + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}

export interface TestFile { path: string; bytes: Uint8Array }
/** A catalog override that replaces the built-in fast tiers with models served from `baseUrl`. */
export function testCatalogOverride(baseUrl: string, files: Record<string, Uint8Array>): Record<string, unknown> {
  const lic = { id: "MIT", name: "MIT", commercial: true, status: "confirmed" };
  const item = (name: string) => ({ url: `${baseUrl}/${name}`, sha256: sha256(files[name]!), sizeBytes: files[name]!.byteLength, path: name });
  const mk = (id: string, kind: string, engine: string, extra: Record<string, unknown> = {}) => ({ [id]: { kind, engine, displayName: id, licence: lic, download: [item(`${id}.bin`)], roles: { model: `${id}.bin` }, ...extra } });
  return {
    models: {
      ...mk("t-vad", "vad", "silero-vad", { sampleRate: 16000 }),
      ...mk("t-stt-de", "stt", "streaming-transducer", { streaming: true, language: "de" }),
      ...mk("t-stt-de-q", "stt", "nemo-transducer", { streaming: false, language: "de" }),
      ...mk("t-tts-de", "tts", "vits", { sampleRate: 16000, language: "de" }),
      ...mk("t-tts-de-nc", "tts", "vits", { sampleRate: 16000, language: "de", licence: { id: "CC-BY-NC", name: "CC BY-NC", commercial: false, status: "confirmed" } }),
      ...mk("t-stt-en", "stt", "streaming-transducer", { streaming: true, language: "en" }),
      ...mk("t-tts-en", "tts", "vits", { sampleRate: 22050, language: "en" }),
      ...mk("t-tts-en-q", "tts", "pocket-tts", { sampleRate: 24000, language: "en" }),
      ...mk("t-kokoro", "tts", "kokoro", { sampleRate: 24000, language: "multi", speakers: { af_heart: 3, am_michael: 16 }, defaultSpeaker: "af_heart" }),
    },
    vad: "t-vad",
    languages: {
      de: { name: "Deutsch", stt: { fast: "t-stt-de", quality: "t-stt-de-q" }, tts: { fast: "t-tts-de", quality: "t-tts-de-nc" } },
      en: { name: "English", stt: { fast: "t-stt-en" }, tts: { fast: "t-tts-en", quality: "t-tts-en-q", fallback: "t-kokoro" } },
    },
  };
}
export function testFiles(): Record<string, Uint8Array> {
  const f: Record<string, Uint8Array> = {};
  let seed = 1;
  for (const id of ["t-vad", "t-stt-de", "t-stt-de-q", "t-tts-de", "t-tts-de-nc", "t-stt-en", "t-tts-en", "t-tts-en-q", "t-kokoro"]) f[`${id}.bin`] = modelBytes(seed++, 3000 + seed * 100);
  return f;
}
