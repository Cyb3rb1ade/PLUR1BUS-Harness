// Binding contract for the media index (contract: ~/plur1bus-merge/briefs/media-search-contract.md, "Engine API (ME1) = core port
// MediaIndexPort (ME2)"). The engine (ME1) ships the same shape as `media.*`; this file is the host-side port. Do not widen it.

export type MediaKind = "image" | "video" | "audio";
export type CaptionSource = "prompt" | "user" | "auto";
export type Segment = { idx: number; startMs: number; endMs: number };

/** Same visibility model as memory entries: the agent plus the principals whose entries the caller may read. */
export type Scope = { agentId: string; principals: readonly string[] };

export type IndexState = "indexed" | "pending" | "unsupported-kind" | "failed";
export type BackfillState = "idle" | "running" | "paused" | "cancelled" | "done";

export interface MediaIndexRequest {
  mediaId: string; kind: MediaKind; mime: string;
  source: { path: string } | { bytes: Uint8Array };
  caption?: string; captionSource?: CaptionSource;
  scope: Scope;
}
export interface MediaSearchRequest {
  text?: string; likeMediaId?: string; // exactly one of the two
  kinds?: MediaKind[]; limit: number; scope: Scope;
  minScore?: number; fuseCaptions?: boolean; // RRF over ranks with caption hits, never vectors
}
export interface MediaHit { mediaId: string; kind: MediaKind; score: number; segment?: Segment; captionMemoryId?: string }

export interface MediaIndexStatus {
  enabled: boolean; provider: string; model: string; variant?: string; dim: number; fingerprint: string;
  counts: { indexed: number; pending: number; failed: number; unsupported: number };
  backfill: { state: BackfillState; done: number; total: number; startedAt?: string; pausedReason?: "budget" | "user" | "error" };
}

export interface MediaIndexPort {
  index(req: MediaIndexRequest): Promise<{ segments: number; state: IndexState }>;
  search(req: MediaSearchRequest): Promise<MediaHit[]>;
  remove(mediaId: string): Promise<void>; // also removes the caption memory entry
  setCaption(mediaId: string, text: string, source: CaptionSource): Promise<void>;
  status(): Promise<MediaIndexStatus>;
  backfill: {
    start(opts: { reason: "enable" | "model-change" | "manual" }): Promise<void>;
    pause(): Promise<void>; resume(): Promise<void>; cancel(): Promise<void>;
  };
}

/** Host → engine: frames of a video. Port missing → engine answers state "unsupported-kind", no crash. */
export type MediaSource = { path: string } | { bytes: Uint8Array };
export interface FrameExtractorPort {
  frames(src: MediaSource, opts: { intervalSec: number; sceneDetect: boolean; maxFrames: number }): AsyncIterable<{ tsMs: number; image: Uint8Array; mime: string }>;
}
/** Host → engine: mono float PCM of audio or of a video's audio track. */
export interface AudioDecoderPort {
  pcm(src: MediaSource, opts: { sampleRate: number; mono: true; maxSeconds: number }): AsyncIterable<{ startMs: number; samples: Float32Array }>;
}
/** Host → engine budget callback; false pauses the backfill with pausedReason="budget". */
export interface BudgetCallback { canContinue(): Promise<boolean> }

export const MEDIA_ERROR_CODES = ["E_MEDIA_CAPABILITY", "E_MEDIA_LICENSE", "E_MEDIA_PRIVACY", "E_MEDIA_UNAVAILABLE", "E_MEDIA_DIMENSION", "E_MEDIA_UNSUPPORTED_KIND"] as const;
export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];
