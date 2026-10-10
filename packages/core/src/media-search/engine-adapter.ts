import type { AudioDecoderPort, BudgetCallback, FrameExtractorPort, MediaIndexPort } from "./types.ts";

/** Host ports handed to the engine through the optional `engine.media.attachHost` hook (assumption: the engine declares it if it needs them). */
export interface MediaHostPorts { frames: FrameExtractorPort | null; audio: AudioDecoderPort | null; budget?: BudgetCallback }
export type EngineMedia = MediaIndexPort & { attachHost?: (host: MediaHostPorts) => void | Promise<void> };

const isFn = (v: unknown): boolean => typeof v === "function";

/** Feature detection by shape only; engine versions are never compared. */
export function detectEngineMedia(engine: unknown): boolean {
  if (typeof engine !== "object" || engine === null) return false;
  const media = (engine as { media?: unknown }).media as Record<string, unknown> | null | undefined;
  if (typeof media !== "object" || media === null) return false;
  if (!["index", "search", "remove", "setCaption", "status"].every((k) => isFn(media[k]))) return false;
  const b = media["backfill"] as Record<string, unknown> | null | undefined;
  return typeof b === "object" && b !== null && ["start", "pause", "resume", "cancel"].every((k) => isFn(b[k]));
}

/** Delegates 1:1 to `engine.media` (the engine ships the MediaIndexPort shape). */
export class EngineMediaIndex implements MediaIndexPort {
  readonly #m: EngineMedia;
  constructor(media: EngineMedia) { this.#m = media; }
  index: MediaIndexPort["index"] = (req) => this.#m.index(req);
  search: MediaIndexPort["search"] = (req) => this.#m.search(req);
  remove: MediaIndexPort["remove"] = (id) => this.#m.remove(id);
  setCaption: MediaIndexPort["setCaption"] = (id, text, source) => this.#m.setCaption(id, text, source);
  status: MediaIndexPort["status"] = () => this.#m.status();
  backfill: MediaIndexPort["backfill"] = {
    start: (opts) => this.#m.backfill.start(opts),
    pause: () => this.#m.backfill.pause(),
    resume: () => this.#m.backfill.resume(),
    cancel: () => this.#m.backfill.cancel(),
  };
}
