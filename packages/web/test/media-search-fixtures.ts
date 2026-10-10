// Mock media search RPC (contract: media-search-contract.md): media.search, media.index.status|pause|resume|reindex and
// media.caption.set, plus the existing media.output.get used to play a hit's file. State lives in the returned object.
// A method is unknown (-32601, shown as unavailable) until a test registers it, as on an engine without the media index.
import { rpcError, type MockRpc } from "./mock-rpc.ts";

export type MediaStatus = {
  enabled: boolean; provider: string; model: string; variant?: string; dim: number; fingerprint: string;
  counts: { indexed: number; pending: number; failed: number; unsupported: number };
  backfill: { state: "idle" | "running" | "paused" | "cancelled" | "done"; done: number; total: number; startedAt?: string; pausedReason?: "budget" | "user" | "error" };
};

export const HIT_VIDEO = { mediaId: "med-video-1", kind: "video", score: 0.91, segment: { idx: 2, startMs: 20000, endMs: 30000 }, caption: "a forest path at dusk" };
export const HIT_AUDIO = { mediaId: "med-audio-1", kind: "audio", score: 0.74, segment: { idx: 0, startMs: 12000, endMs: 42000 } };
export const HIT_IMAGE = { mediaId: "med-image-1", kind: "image", score: 0.62, caption: "a red bridge" };

export type MediaFake = { status: MediaStatus; searches: unknown[]; captions: unknown[]; actions: string[] };

export function status(over: Partial<MediaStatus> = {}): MediaStatus {
  return {
    enabled: true, provider: "egemma2", model: "google/embeddinggemma-2", variant: "image+video+audio", dim: 768, fingerprint: "fp-1",
    counts: { indexed: 120, pending: 14, failed: 2, unsupported: 1 },
    backfill: { state: "running", done: 40, total: 135 },
    ...over,
  };
}

/** Registers the media methods on the mock. `opts.status` sets the initial status, `opts.searchError` makes every search fail with
 * that E_MEDIA code, `opts.noStatus` leaves media.index.status unregistered (an engine without the media index). */
export function seedMedia(rpc: MockRpc, opts: { status?: Partial<MediaStatus>; searchError?: string; noStatus?: boolean } = {}): MediaFake {
  const f: MediaFake = { status: status(opts.status), searches: [], captions: [], actions: [] };
  if (!opts.noStatus) rpc.handle("media.index.status", () => ({ ...f.status }), { write: false });
  rpc.handle("media.index.pause", () => { f.actions.push("pause"); f.status = { ...f.status, backfill: { ...f.status.backfill, state: "paused", pausedReason: "user" } }; return { ...f.status }; });
  rpc.handle("media.index.resume", () => { f.actions.push("resume"); f.status = { ...f.status, backfill: { done: f.status.backfill.done, total: f.status.backfill.total, state: "running" } }; return { ...f.status }; });
  rpc.handle("media.index.reindex", (p) => {
    if ((p as { confirm?: unknown } | undefined)?.confirm !== true) throw rpcError("E_INVALID_PARAMS", "confirm required");
    f.actions.push("reindex");
    f.status = { ...f.status, backfill: { state: "running", done: 0, total: 135 } };
    return { ...f.status };
  });
  rpc.handle("media.search", (p) => {
    f.searches.push(p);
    if (opts.searchError) { const code = opts.searchError; throw rpcError(code as never, `${code}: refused`, code.toLowerCase()); }
    const q = p as { text?: string; likeMediaId?: string; kinds?: string[] };
    const all = [HIT_VIDEO, HIT_AUDIO, HIT_IMAGE];
    const hits = all.filter((h) => !q.kinds || q.kinds.includes(h.kind));
    return { hits: q.likeMediaId ? hits.filter((h) => h.mediaId !== q.likeMediaId) : hits };
  });
  rpc.handle("media.caption.set", (p) => { f.captions.push(p); return { ok: true }; });
  rpc.handle("media.output.get", () => ({ data: "UklGRg==", mimeType: "audio/wav" }), { write: false });
  rpc.handle("media.output.list", () => ({ outputs: [] }), { write: false });
  return f;
}
