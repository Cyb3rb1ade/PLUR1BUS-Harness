// Media search wire types, transcribed from the binding contract (media-search-contract.md, status 2026-10-10): the RPC
// methods `media.search`, `media.index.status|pause|resume|reindex`, `media.caption.set`, the config keys under
// `memory.mediaEmbedding.*` and the error codes `E_MEDIA_*`.
//
// TEMPORARY: these are hand-written until the RPC types are generated from the engine. The follow-up is to replace this
// file with the generated types (see docs/web-ui.md, "Folgearbeit"). Do not add fields that the contract does not name.

export type MediaKind = "image" | "video" | "audio";
export type CaptionSource = "prompt" | "user" | "auto";
export type Segment = { idx: number; startMs: number; endMs: number };

export type BackfillState = "idle" | "running" | "paused" | "cancelled" | "done";
export type PausedReason = "budget" | "user" | "error";

/** `media.index.status` result = the engine's `status()`. */
export type MediaIndexStatus = {
  enabled: boolean;
  provider: string;
  model: string;
  variant?: string;
  dim: number;
  fingerprint: string;
  counts: { indexed: number; pending: number; failed: number; unsupported: number };
  backfill: { state: BackfillState; done: number; total: number; startedAt?: string; pausedReason?: PausedReason };
};

// ---- RPC -----------------------------------------------------------------------------------------------------------

/** Exactly one of `text` and `likeMediaId`. `limit` defaults to 20, `fuseCaptions` to false (server side). */
export type MediaSearchParams =
  | { text: string; likeMediaId?: never; kinds?: MediaKind[]; limit?: number; fuseCaptions?: boolean }
  | { likeMediaId: string; text?: never; kinds?: MediaKind[]; limit?: number; fuseCaptions?: boolean };

export type MediaHit = {
  mediaId: string;
  kind: MediaKind;
  score: number;
  segment?: Segment;
  caption?: string;
  thumbnailUrl?: string;
};
export type MediaSearchResult = { hits: MediaHit[] };

export type MediaIndexReindexParams = { confirm: true };
export type MediaCaptionSetParams = { mediaId: string; text: string };
export type MediaCaptionSetResult = { ok: true };

// ---- Catalogue (the existing embedding catalogue, extended additively) -----------------------------------------

export type MediaCapabilities = { text: boolean; image: boolean; video: boolean; audio: boolean };

// ---- Config keys (memory.mediaEmbedding.*) ---------------------------------------------------------------------------

export type MediaModality = "image" | "video" | "audio";
export type CaptionSourceSetting = "prompt-then-user-then-auto" | "user-only" | "off";
export type MediaBackfillSetting = "auto" | "manual";
/** Provider IDs are strings; `"off"` disables the index (provider) or captioning (caption.provider). */
export type ProviderOrOff = string | "off";

/** Global settings, as `config.get` returns them under `memory.mediaEmbedding`. Keys not set take the contract default. */
export type MediaEmbeddingConfig = {
  enabled: boolean;
  provider: ProviderOrOff;
  model: string;
  dimensions: 768 | 512 | 256 | 128;
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

/** Contract defaults for new installations (`memory.mediaEmbedding.*`). Captioning provider is not part of the default; the
 * caller sets it to local when embedding is local, and leaves it unset (setup asks) when embedding is cloud. */
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

// ---- Errors -----------------------------------------------------------------------------------------------------

/** Codes from docs/errors.md (contract). Each has a user-facing text under `media.error.*`. */
export const MEDIA_ERROR_CODES = [
  "E_MEDIA_CAPABILITY",
  "E_MEDIA_LICENSE",
  "E_MEDIA_PRIVACY",
  "E_MEDIA_UNAVAILABLE",
  "E_MEDIA_DIMENSION",
  "E_MEDIA_UNSUPPORTED_KIND",
] as const;
export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];
export const isMediaErrorCode = (v: unknown): v is MediaErrorCode => typeof v === "string" && (MEDIA_ERROR_CODES as readonly string[]).includes(v);

/** RPC methods, one place, so the UI and the mock server agree on names. */
export const MEDIA_METHODS = {
  search: "media.search",
  indexStatus: "media.index.status",
  indexPause: "media.index.pause",
  indexResume: "media.index.resume",
  indexReindex: "media.index.reindex",
  captionSet: "media.caption.set",
} as const;
