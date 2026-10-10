// Local caption provider.
//
// Model choice (Florence-2, MIT). @huggingface/transformers is not installed in this tree (the engine package declares
// it, "4.2.0", as its own dependency), so Florence-2 support could not be run here; it is taken from the library's public
// API (Florence2ForConditionalGeneration + AutoProcessor with the ONNX export onnx-community/Florence-2-base-ft, which runs
// in Node on onnxruntime-node). The model is small (base, ~230M parameters), MIT licensed like the harness, and needs no
// licence dialog. The library and the weights load lazily behind an injectable loader, never from the network implicitly;
// if the loader or the model is unavailable the provider fails with E_MEDIA_UNAVAILABLE and SmolVLM (Apache-2.0) is the
// documented fallback entry in CAPTION_MODELS.
import { join } from "node:path";
import { access } from "node:fs/promises";
import type { AsrProvider } from "../../../../voice-providers/src/types.ts";
import { float32ToPcm16 } from "../../../../voice-providers/src/local/providers.ts";
import type { AudioDecoderPort, FrameExtractorPort, MediaSource } from "../types.ts";
import { mediaError } from "../errors.ts";
import { composeCaptionProvider } from "./keyframes.ts";
import type { CaptionProvider } from "./types.ts";

export interface CaptionModelPin {
  /** Hugging Face repo id. */
  id: string;
  /** Commit hash; "TODO-PIN" until read from the hub (no network in this change). */
  revision: string;
  files: { path: string; sha256: string; sizeBytes: number | null }[];
  licence: { id: string; name: string; commercial: boolean };
  sizeBytes: number | null;
}
/** TODO-PIN: revision and per-file SHA-256 must be filled from the hub before the downloader may fetch these. */
export const CAPTION_MODELS: Readonly<Record<string, CaptionModelPin>> = {
  "florence-2-base-ft": {
    id: "onnx-community/Florence-2-base-ft", revision: "TODO-PIN",
    files: [{ path: "onnx/*", sha256: "TODO-PIN", sizeBytes: null }],
    licence: { id: "MIT", name: "MIT License", commercial: true }, sizeBytes: null,
  },
  "smolvlm-256m": {
    id: "HuggingFaceTB/SmolVLM-256M-Instruct", revision: "TODO-PIN",
    files: [{ path: "onnx/*", sha256: "TODO-PIN", sizeBytes: null }],
    licence: { id: "Apache-2.0", name: "Apache License 2.0", commercial: true }, sizeBytes: null,
  },
};
export const DEFAULT_CAPTION_MODEL = "florence-2-base-ft";
export const isPinned = (pin: CaptionModelPin) => pin.revision !== "TODO-PIN" && pin.files.every(f => f.sha256 !== "TODO-PIN");
/** Text shown before a download, as for the voice catalogue: model, size, licence. */
export const captionModelNotice = (pin: CaptionModelPin) => `${pin.id} (${pin.licence.name}${pin.licence.commercial ? "" : ", non-commercial"}${pin.sizeBytes ? `, ${Math.round(pin.sizeBytes / 1e6)} MB` : ""})`;

/** What the lazily loaded model offers. */
export interface ImageCaptioner { captionImage(image: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> }
export type CaptionLoader = (o: { modelDir: string; model: CaptionModelPin }) => Promise<ImageCaptioner>;

/** Default loader: transformers.js, offline, from a directory the downloader has filled. */
export const loadFlorence: CaptionLoader = async ({ modelDir }) => {
  try { await access(modelDir); } catch { throw mediaError("E_MEDIA_UNAVAILABLE", "caption model is not installed"); }
  const spec = "@huggingface/transformers";
  const tf: any = await import(spec).catch(() => { throw mediaError("E_MEDIA_UNAVAILABLE", "@huggingface/transformers is not available"); });
  tf.env.allowRemoteModels = false;
  tf.env.localModelPath = join(modelDir, "..");
  const name = modelDir.split(/[\\/]/).pop()!;
  const [model, processor, tokenizer] = await Promise.all([
    tf.Florence2ForConditionalGeneration.from_pretrained(name, { dtype: "q8" }),
    tf.AutoProcessor.from_pretrained(name),
    tf.AutoTokenizer.from_pretrained(name),
  ]);
  const task = "<CAPTION>";
  return {
    async captionImage(bytes, mime, signal) {
      signal?.throwIfAborted();
      const image = await tf.RawImage.fromBlob(new Blob([bytes as BlobPart], { type: mime }));
      const inputs = await processor(image, processor.construct_prompts(task));
      const ids = await model.generate({ ...inputs, max_new_tokens: 100 });
      const decoded = tokenizer.batch_decode(ids, { skip_special_tokens: false })[0];
      const out = processor.post_process_generation(decoded, task, image.size);
      return String(out[task] ?? "");
    },
  };
};

const ASR_RATE = 16000;
const CHUNK_SECONDS = 30;
/** Transcript of the first minutes through the local ASR (voice-providers); stops once `maxChars` are reached. */
export function localTranscriber(o: { asr: AsrProvider; decoder: AudioDecoderPort; maxChars: () => number; maxSeconds?: number }) {
  return async (src: MediaSource, signal?: AbortSignal): Promise<string> => {
    let text = "";
    for await (const chunk of o.decoder.pcm(src, { sampleRate: ASR_RATE, mono: true, maxSeconds: o.maxSeconds ?? CHUNK_SECONDS * 4 })) {
      signal?.throwIfAborted();
      const r = await o.asr.transcribe({ format: "pcm16", sampleRate: ASR_RATE, data: float32ToPcm16(chunk.samples) }, signal ? { signal } : {});
      text = `${text} ${r.text}`.trim();
      if (text.length >= o.maxChars()) break;
    }
    return text;
  };
}

export interface LocalCaptionOptions {
  /** Directory of the installed model (`<home>/models/caption/<name>`). */
  modelDir: string;
  model?: CaptionModelPin;
  loader?: CaptionLoader;
  maxChars: () => number;
  extractor?: FrameExtractorPort;
  transcribe?: (src: MediaSource, signal?: AbortSignal) => Promise<string>;
}
export function createLocalCaptionProvider(o: LocalCaptionOptions): CaptionProvider {
  const model = o.model ?? CAPTION_MODELS[DEFAULT_CAPTION_MODEL]!;
  let loaded: Promise<ImageCaptioner> | undefined;
  const engine = () => (loaded ??= (o.loader ?? loadFlorence)({ modelDir: o.modelDir, model }).catch(e => { loaded = undefined; throw e; }));
  return composeCaptionProvider({
    id: "local", local: true, maxChars: o.maxChars,
    captionImage: async (image, mime, signal) => (await engine()).captionImage(image, mime, signal),
    ...(o.extractor ? { extractor: o.extractor } : {}), ...(o.transcribe ? { transcribe: o.transcribe } : {}),
  });
}
