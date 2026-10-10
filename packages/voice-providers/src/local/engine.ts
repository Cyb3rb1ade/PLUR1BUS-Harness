// The seam between the package and the speech runtime. Everything above this file (providers, language manager,
// tests) talks to `LocalEngine`; `sherpa-onnx-node` is loaded lazily by `createSherpaEngine` only when a model is
// actually loaded, so the package imports, typechecks and unit-tests without the native module installed.
import { join } from "node:path";
import { VoiceProviderError } from "../errors.ts";
import type { CatalogModel } from "./catalog.ts";

export interface ResolvedModel {
  model: CatalogModel;
  dir: string;
  /** role -> absolute path */
  paths: Record<string, string>;
}
export function resolveModel(model: CatalogModel, dir: string): ResolvedModel {
  const paths: Record<string, string> = {};
  for (const [role, rel] of Object.entries(model.roles)) paths[role] = join(dir, rel);
  return { model, dir, paths };
}

export type Availability = { ok: true } | { ok: false; reason: string };

export interface LocalAsrStream {
  acceptWaveform(samples: Float32Array, sampleRate: number): void;
  /** Current hypothesis and whether the recogniser's endpoint rule fired. */
  result(): { text: string; isEndpoint: boolean };
  /** Mark input finished and decode what is left. */
  finish(): { text: string };
  reset(): void;
  dispose(): void;
}
export interface LoadedAsr {
  readonly streaming: boolean;
  createStream(): LocalAsrStream;
  decodeOffline(samples: Float32Array, sampleRate: number): Promise<{ text: string }>;
  /** One short dummy inference so the first real request does not pay for lazy initialisation. */
  warm(): Promise<void>;
  dispose(): void;
}
export interface LoadedTts {
  readonly sampleRate: number;
  readonly speakers: number;
  generate(text: string, options: { speaker?: number; speed?: number }): Promise<{ samples: Float32Array; sampleRate: number }>;
  warm(): Promise<void>;
  dispose(): void;
}
export interface LoadedVad {
  acceptWaveform(samples: Float32Array): void;
  isSpeech(): boolean;
  reset(): void;
  dispose(): void;
}
export interface LocalEngine {
  availability(): Availability;
  /** Engine kinds this runtime can run for a model kind; used to refuse an entry with a clear message. */
  supports(kind: "stt" | "tts" | "vad", engine: string): boolean;
  loadAsr(model: ResolvedModel): Promise<LoadedAsr>;
  loadTts(model: ResolvedModel): Promise<LoadedTts>;
  loadVad(model: ResolvedModel): Promise<LoadedVad>;
}

export const SUPPORTED_PLATFORMS: ReadonlyArray<{ platform: NodeJS.Platform; arch: string }> = [
  { platform: "linux", arch: "x64" }, { platform: "linux", arch: "arm64" },
  { platform: "darwin", arch: "x64" }, { platform: "darwin", arch: "arm64" },
  { platform: "win32", arch: "x64" }, { platform: "win32", arch: "ia32" },
];

export function platformAvailability(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Availability {
  if (SUPPORTED_PLATFORMS.some((p) => p.platform === platform && p.arch === arch)) return { ok: true };
  return { ok: false, reason: `local voice (sherpa-onnx) has no build for ${platform}/${arch}; use a cloud voice provider on this machine` };
}

export interface SherpaEngineOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  numThreads?: number;
  /** Test seam: replaces the lazy import of the native module. */
  loadModule?: () => Promise<any>;
}

/**
 * Free a native object. VERIFY at integration: the sherpa-onnx-node binding frees through the garbage collector in
 * the releases we know of and may expose none of these; each name is called only when it exists, and a failing free
 * never breaks the caller.
 */
function freeNative(x: unknown): void {
  const o = x as Record<string, unknown> | null | undefined;
  if (!o) return;
  for (const name of ["free", "delete", "destroy"]) {
    if (typeof o[name] === "function") {
      try { (o[name] as () => void)(); } catch { /* best effort */ }
      return;
    }
  }
}

const STT_ENGINES = new Set(["streaming-transducer", "nemo-transducer"]);
const TTS_ENGINES = new Set(["vits", "kokoro"]);

/**
 * sherpa-onnx-node engine. The configuration shapes below follow the binding's documented JS API (VERIFY at
 * integration against the pinned sherpa-onnx-node release with real model files; this repository's tests use a fake
 * engine, not the native module).
 */
export function createSherpaEngine(o: SherpaEngineOptions = {}): LocalEngine {
  let modP: Promise<any> | undefined;
  const threads = o.numThreads ?? 2;
  const load = (): Promise<any> => (modP ??= (o.loadModule ?? defaultLoad)().catch((e) => { modP = undefined; throw e; }));
  async function defaultLoad(): Promise<any> {
    try {
      const spec = "sherpa-onnx-node";
      const m: any = await import(/* @vite-ignore */ spec);
      return m.default ?? m;
    } catch {
      throw new VoiceProviderError("unavailable", "sherpa-onnx-node is not installed or failed to load on this platform (optional peer dependency)");
    }
  }
  return {
    availability: () => platformAvailability(o.platform, o.arch),
    supports: (kind, engine) => (kind === "stt" ? STT_ENGINES.has(engine) : kind === "tts" ? TTS_ENGINES.has(engine) : engine === "silero-vad"),

    async loadAsr(m) {
      const s = await load();
      const p = m.paths;
      const streaming = m.model.engine === "streaming-transducer";
      const transducer = { encoder: p["encoder"], decoder: p["decoder"], joiner: p["joiner"] };
      const common = { tokens: p["tokens"], numThreads: threads, provider: "cpu", debug: 0 };
      if (streaming) {
        const live = new Set<unknown>();
        const rec = new s.OnlineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer, ...common }, decodingMethod: "greedy_search", enableEndpoint: 1 });
        return {
          streaming: true,
          createStream() {
            const st = rec.createStream();
            live.add(st);
            return {
              acceptWaveform: (samples, sampleRate) => { st.acceptWaveform({ sampleRate, samples }); while (rec.isReady(st)) rec.decode(st); },
              result: () => ({ text: String(rec.getResult(st).text ?? "").trim(), isEndpoint: rec.isEndpoint(st) === true }),
              finish: () => { st.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(8000) }); while (rec.isReady(st)) rec.decode(st); return { text: String(rec.getResult(st).text ?? "").trim() }; },
              reset: () => rec.reset(st),
              dispose: () => { if (live.delete(st)) freeNative(st); },
            };
          },
          async decodeOffline(samples, sampleRate) {
            const st = rec.createStream();
            st.acceptWaveform({ sampleRate, samples });
            st.acceptWaveform({ sampleRate, samples: new Float32Array(Math.round(sampleRate / 2)) });
            while (rec.isReady(st)) rec.decode(st);
            const text = String(rec.getResult(st).text ?? "").trim();
            freeNative(st);
            return { text };
          },
          async warm() { const st = rec.createStream(); st.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000) }); while (rec.isReady(st)) rec.decode(st); freeNative(st); },
          dispose() { for (const st of live) freeNative(st); live.clear(); freeNative(rec); },
        };
      }
      const rec = new s.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer, ...common, modelType: "nemo_transducer" } });
      const run = async (samples: Float32Array, sampleRate: number) => {
        const st = rec.createStream();
        st.acceptWaveform({ sampleRate, samples });
        await rec.decodeAsync(st);
        const text = String(rec.getResult(st).text ?? "").trim();
        freeNative(st);
        return { text };
      };
      return {
        streaming: false,
        createStream() { throw new VoiceProviderError("unsupported", "this ASR model is not a streaming model"); },
        decodeOffline: run,
        warm: async () => { await run(new Float32Array(16000), 16000); },
        dispose() { freeNative(rec); },
      };
    },

    async loadTts(m) {
      const s = await load();
      const p = m.paths;
      const model = m.model.engine === "kokoro"
        ? { kokoro: { model: p["model"], voices: p["voices"], tokens: p["tokens"], dataDir: p["dataDir"], ...(p["lexicon"] ? { lexicon: p["lexicon"] } : {}) } }
        : { vits: { model: p["model"], tokens: p["tokens"], dataDir: p["dataDir"], ...(p["lexicon"] ? { lexicon: p["lexicon"] } : {}) } };
      const tts = new s.OfflineTts({ model: { ...model, numThreads: threads, provider: "cpu", debug: 0 }, maxNumSentences: 1 });
      const gen = async (text: string, opt: { speaker?: number; speed?: number }) => {
        const r = await tts.generateAsync({ text, sid: opt.speaker ?? 0, speed: opt.speed ?? 1.0 });
        return { samples: r.samples as Float32Array, sampleRate: Number(r.sampleRate) };
      };
      return { sampleRate: Number(tts.sampleRate), speakers: Number(tts.numSpeakers ?? 1), generate: gen, warm: async () => { await gen("Hi.", {}); }, dispose() { freeNative(tts); } };
    },

    async loadVad(m) {
      const s = await load();
      const vad = new s.Vad({ sileroVad: { model: m.paths["model"], threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.1, windowSize: 512 }, sampleRate: 16000, debug: false, numThreads: 1 }, 30);
      return {
        acceptWaveform: (samples) => vad.acceptWaveform(samples),
        isSpeech: () => vad.isDetected() === true,
        reset: () => vad.reset?.(),
        dispose() { freeNative(vad); },
      };
    },
  };
}
