import { readFile } from "node:fs/promises";
import type { AudioDecoderPort, FrameExtractorPort, MediaSource } from "../types.ts";
import { mediaError } from "../errors.ts";
import { normaliseCaption } from "./service.ts";
import type { CaptionInput, CaptionProvider } from "./types.ts";

export const KEYFRAME_MIN = 3;
export const KEYFRAME_MAX = 5;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export async function readSource(src: MediaSource): Promise<Uint8Array> {
  if ("bytes" in src) return src.bytes;
  const bytes = await readFile(src.path);
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "medium too large to caption");
  return bytes;
}

/** Pick up to `n` items spread evenly over the list, first and last included. */
export function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]!);
}

/** Deterministic merge without an LLM: order by time, drop repeats (case-insensitive), join with "; ". */
export function mergeFrameCaptions(parts: readonly { tsMs: number; text: string }[], maxChars: number): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...parts].sort((a, b) => a.tsMs - b.tsMs)) {
    const text = p.text.replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return normaliseCaption(out.join("; "), maxChars);
}

export interface FrameCaptionOptions {
  extractor: FrameExtractorPort;
  captionImage: (image: Uint8Array, mime: string, signal?: AbortSignal) => Promise<string>;
  maxChars: number;
  /** Keyframes to caption, clamped to 3..5. */
  frames?: number;
}
export async function captionVideoByKeyframes(src: MediaSource, o: FrameCaptionOptions, signal?: AbortSignal): Promise<string> {
  const want = Math.min(KEYFRAME_MAX, Math.max(KEYFRAME_MIN, o.frames ?? KEYFRAME_MAX));
  const frames: { tsMs: number; image: Uint8Array; mime: string }[] = [];
  for await (const f of o.extractor.frames(src, { intervalSec: 10, sceneDetect: true, maxFrames: want * 4 })) {
    signal?.throwIfAborted();
    frames.push(f);
    if (frames.length >= want * 4) break;
  }
  if (!frames.length) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "no frames could be extracted");
  const parts: { tsMs: number; text: string }[] = [];
  for (const f of spread(frames, want)) parts.push({ tsMs: f.tsMs, text: await o.captionImage(f.image, f.mime, signal) });
  return mergeFrameCaptions(parts, o.maxChars);
}

export interface ComposedCaptionOptions {
  id: string;
  local: boolean;
  maxChars: () => number;
  captionImage: (image: Uint8Array, mime: string, signal?: AbortSignal) => Promise<string>;
  extractor?: FrameExtractorPort;
  /** Audio -> transcript (local ASR only); absent: audio is unsupported. */
  transcribe?: (src: MediaSource, signal?: AbortSignal) => Promise<string>;
}
/** One provider for all three kinds: image directly, video by keyframes, audio by transcript. */
export function composeCaptionProvider(o: ComposedCaptionOptions): CaptionProvider {
  return {
    id: o.id,
    local: o.local,
    async caption(input: CaptionInput) {
      input.signal?.throwIfAborted();
      if (input.kind === "image") return o.captionImage(await readSource(input.source), input.mime, input.signal);
      if (input.kind === "video") {
        if (!o.extractor) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "no frame extractor for video captions");
        return captionVideoByKeyframes(input.source, { extractor: o.extractor, captionImage: o.captionImage, maxChars: o.maxChars() }, input.signal);
      }
      if (!o.transcribe) throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "no speech recogniser for audio captions");
      return normaliseCaption(await o.transcribe(input.source, input.signal), o.maxChars());
    },
  };
}
