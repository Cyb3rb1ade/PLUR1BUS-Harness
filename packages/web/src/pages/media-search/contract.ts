// Media search contract types that are not RPC shapes: the `memory.mediaEmbedding.*` config keys (config.schema.json), the
// catalogue capabilities the forms show, and the `E_MEDIA_*` codes the UI maps to text. RPC shapes come from the generated
// types (rpc-types.ts, packages/rpc-schema/generated/types.ts), never from here.
import type { ErrorCode, MediaIndexKind } from "../../../../rpc-schema/generated/types.ts";

export type MediaModality = MediaIndexKind;
export type CaptionSourceSetting = "prompt-then-user-then-auto" | "user-only" | "off";
export type MediaBackfillSetting = "auto" | "manual";
/** Provider IDs are strings; `"off"` disables the index (provider) or captioning (caption.provider). */
export type ProviderOrOff = string | "off";

/** Global settings, as `config.get` returns them under `memory.mediaEmbedding` (config.schema.json). Keys not set take the
 * schema default. `dimensions` is any integer of at least 1 in the schema; the model's own list (768, 512, 256, 128 for
 * EmbeddingGemma) is checked by the forms, not by the type. */
export type MediaEmbeddingConfig = {
  enabled: boolean;
  provider: ProviderOrOff;
  model: string;
  dimensions: number;
  modalities: MediaModality[];
  video: { segmentSec: number; maxFrames: number; sceneDetect: boolean };
  audio: { segmentSec: number; maxSeconds: number };
  caption: { source: CaptionSourceSetting; provider?: ProviderOrOff; maxChars: number; perSegment: boolean };
  backfill: MediaBackfillSetting;
};

/** Per-agent override, `agents.<id>.memory.mediaEmbedding.*`: the same structure, every field optional (missing = inherit). */
export type MediaEmbeddingOverride = Partial<Omit<MediaEmbeddingConfig, "video" | "audio" | "caption">> & {
  video?: Partial<MediaEmbeddingConfig["video"]>;
  audio?: Partial<MediaEmbeddingConfig["audio"]>;
  caption?: Partial<MediaEmbeddingConfig["caption"]>;
};

export type MediaCapabilities = { text: boolean; image: boolean; video: boolean; audio: boolean };

/** Defaults of `memory.mediaEmbedding` for the forms. The schema's defaults are the same except `provider`: the schema says
 * `local-transformers` (the engine's provider name), while the forms preselect the catalogue entry `egemma2`. The forms
 * keep their own ID until the catalogue and the provider names are one list (docs/web-ui.md, F48). Captioning provider is
 * not part of the default; the caller sets it to local when embedding is local, and leaves it unset when embedding is cloud. */
export const MEDIA_EMBEDDING_DEFAULTS = {
  enabled: true,
  provider: "egemma2",
  model: "google/embeddinggemma-2",
  dimensions: 768,
  modalities: ["image", "video", "audio"],
  video: { segmentSec: 10, maxFrames: 32, sceneDetect: true },
  audio: { segmentSec: 30, maxSeconds: 3600 },
  caption: { source: "prompt-then-user-then-auto", maxChars: 280, perSegment: false },
  backfill: "auto",
} as const satisfies Omit<MediaEmbeddingConfig, "caption"> & { caption: Omit<MediaEmbeddingConfig["caption"], "provider"> };

/** The media codes of the closed `ErrorCode` enum of the schema (docs/errors.md). Each has a user-facing text under `media.error.*`. */
export const MEDIA_ERROR_CODES = [
  "E_MEDIA_CAPABILITY",
  "E_MEDIA_LICENSE",
  "E_MEDIA_PRIVACY",
  "E_MEDIA_UNAVAILABLE",
  "E_MEDIA_DIMENSION",
  "E_MEDIA_UNSUPPORTED_KIND",
] as const satisfies readonly ErrorCode[];
export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];
export const isMediaErrorCode = (v: unknown): v is MediaErrorCode => typeof v === "string" && (MEDIA_ERROR_CODES as readonly string[]).includes(v);
