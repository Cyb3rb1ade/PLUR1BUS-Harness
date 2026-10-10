import { RpcError } from "../rpc/errors.ts";
import { mediaError } from "./errors.ts";
import type {
  BackfillState, BudgetCallback, CaptionSource, IndexState, MediaHit, MediaIndexPort, MediaIndexRequest, MediaIndexStatus, MediaKind, MediaSearchRequest, Scope, Segment,
} from "./types.ts";

export interface InMemoryCaptions {
  search(text: string, limit: number): Promise<Array<{ mediaId: string; captionMemoryId?: string }>>;
  set?(mediaId: string, text: string, source: CaptionSource, scope: Scope): Promise<void> | void;
  remove?(mediaId: string): Promise<void> | void;
}
export interface InMemoryMediaIndexOptions {
  provider: string; model: string; dim: number; fingerprint: string; variant?: string;
  embedText(text: string, opts: { queryFor: "media" }): Promise<number[]>;
  embedMedia(req: MediaIndexRequest): Promise<{ vectors: number[][]; segments: Segment[] }>;
  captions?: InMemoryCaptions;
  /** Media still to be indexed by a backfill. */
  listUnindexed?(): AsyncIterable<MediaIndexRequest>;
  budget?: BudgetCallback;
  /** Kinds this index handles; others end as "unsupported-kind". Default: all. */
  modalities?: MediaKind[];
  now?: () => string;
}

interface Item { kind: MediaKind; scope: Scope; state: IndexState; vectors: number[][]; segments: Segment[]; caption?: string }

const RRF_K = 60;
const isCode = (e: unknown, code: string): boolean => e instanceof RpcError && e.error === (code as RpcError["error"]);

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
const visible = (stored: Scope, asker: Scope): boolean => stored.agentId === asker.agentId || (stored.user !== undefined && stored.user === asker.user);

/**
 * Brute-force reference implementation for tests (no persistence, no timers).
 * Backfill is synchronous with the call: `start()` and `resume()` return after the queue is drained, paused or cancelled.
 * `drain()` re-runs the loop explicitly (e.g. after `budget` allows again without `resume()`).
 */
export class InMemoryMediaIndex implements MediaIndexPort {
  readonly #o: InMemoryMediaIndexOptions;
  readonly #items = new Map<string, Item>();
  #queue: MediaIndexRequest[] = [];
  #bf: { state: BackfillState; done: number; total: number; startedAt?: string; pausedReason?: "budget" | "user" | "error" } = { state: "idle", done: 0, total: 0 };
  #loop: Promise<void> | null = null;

  constructor(opts: InMemoryMediaIndexOptions) { this.#o = opts; }

  #checkDim(v: number[]): void {
    if (v.length !== this.#o.dim) throw mediaError("E_MEDIA_DIMENSION", `Vector has ${v.length} dimensions, index uses ${this.#o.dim}`, { reason: String(v.length) });
  }

  async index(req: MediaIndexRequest): Promise<{ segments: number; state: IndexState }> {
    const base = { kind: req.kind, scope: req.scope, vectors: [] as number[][], segments: [] as Segment[] };
    const finish = (state: IndexState, extra: Partial<Item> = {}) => { this.#items.set(req.mediaId, { ...base, state, ...extra }); return { segments: (extra.segments ?? []).length, state }; };
    if (this.#o.modalities && !this.#o.modalities.includes(req.kind)) return finish("unsupported-kind");
    let out: { vectors: number[][]; segments: Segment[] };
    try { out = await this.#o.embedMedia(req); }
    catch (e) { return finish(isCode(e, "E_MEDIA_UNSUPPORTED_KIND") ? "unsupported-kind" : "failed"); }
    for (const v of out.vectors) this.#checkDim(v);
    const r = finish("indexed", { vectors: out.vectors, segments: out.segments, ...(req.caption !== undefined ? { caption: req.caption } : {}) });
    if (req.caption !== undefined) await this.#o.captions?.set?.(req.mediaId, req.caption, req.captionSource ?? "user", req.scope);
    return r;
  }

  async search(req: MediaSearchRequest): Promise<MediaHit[]> {
    if ((req.text === undefined) === (req.likeMediaId === undefined)) throw new RpcError("E_INVALID_PARAMS", "exactly one of text or likeMediaId is required");
    let queries: number[][]; let captionText: string | undefined = req.text;
    if (req.text !== undefined) queries = [await this.#o.embedText(req.text, { queryFor: "media" })];
    else {
      const src = this.#items.get(req.likeMediaId!);
      if (!src || !visible(src.scope, req.scope)) throw new RpcError("E_NOT_FOUND", `media ${req.likeMediaId} not found`);
      queries = src.vectors; captionText = src.caption;
    }
    for (const q of queries) this.#checkDim(q);
    const wanted = (id: string, it: Item | undefined): it is Item => it !== undefined && id !== req.likeMediaId && visible(it.scope, req.scope) && (!req.kinds || req.kinds.includes(it.kind));

    const vec: MediaHit[] = [];
    for (const [mediaId, it] of this.#items) {
      if (!wanted(mediaId, it) || it.state !== "indexed") continue;
      let best = -Infinity, bestIdx = 0;
      it.vectors.forEach((v, i) => { for (const q of queries) { const s = cosine(q, v); if (s > best) { best = s; bestIdx = i; } } });
      if (best === -Infinity || (req.minScore !== undefined && best < req.minScore)) continue;
      const seg = it.segments[bestIdx];
      vec.push({ mediaId, kind: it.kind, score: best, ...(it.kind !== "image" && seg ? { segment: seg } : {}) });
    }
    vec.sort((a, b) => b.score - a.score || (a.mediaId < b.mediaId ? -1 : 1));
    if (!req.fuseCaptions || !this.#o.captions || captionText === undefined) return vec.slice(0, req.limit);

    // Reciprocal rank fusion over ranks only; cosine scores and caption scores are never mixed.
    const capHits = (await this.#o.captions.search(captionText, Math.max(req.limit, 50))).filter((h) => wanted(h.mediaId, this.#items.get(h.mediaId)));
    const fused = new Map<string, MediaHit>();
    vec.forEach((h, i) => fused.set(h.mediaId, { ...h, score: 1 / (RRF_K + i + 1) }));
    const seen = new Set<string>(); let rank = 0;
    for (const c of capHits) {
      if (seen.has(c.mediaId)) continue;
      seen.add(c.mediaId); rank++;
      const add = 1 / (RRF_K + rank);
      const cur = fused.get(c.mediaId);
      if (cur) { cur.score += add; if (c.captionMemoryId) cur.captionMemoryId = c.captionMemoryId; }
      else { const it = this.#items.get(c.mediaId)!; fused.set(c.mediaId, { mediaId: c.mediaId, kind: it.kind, score: add, ...(c.captionMemoryId ? { captionMemoryId: c.captionMemoryId } : {}) }); }
    }
    return [...fused.values()].sort((a, b) => b.score - a.score || (a.mediaId < b.mediaId ? -1 : 1)).slice(0, req.limit);
  }

  async remove(mediaId: string): Promise<void> {
    this.#items.delete(mediaId);
    this.#queue = this.#queue.filter((r) => r.mediaId !== mediaId);
    await this.#o.captions?.remove?.(mediaId);
  }

  async setCaption(mediaId: string, text: string, source: CaptionSource): Promise<void> {
    const it = this.#items.get(mediaId);
    if (!it) throw new RpcError("E_NOT_FOUND", `media ${mediaId} not found`);
    it.caption = text;
    await this.#o.captions?.set?.(mediaId, text, source, it.scope);
  }

  async status(): Promise<MediaIndexStatus> {
    const counts = { indexed: 0, pending: this.#queue.length, failed: 0, unsupported: 0 };
    for (const it of this.#items.values()) {
      if (it.state === "indexed") counts.indexed++; else if (it.state === "failed") counts.failed++;
      else if (it.state === "unsupported-kind") counts.unsupported++; else counts.pending++;
    }
    const o = this.#o;
    return { enabled: true, provider: o.provider, model: o.model, ...(o.variant ? { variant: o.variant } : {}), dim: o.dim, fingerprint: o.fingerprint, counts, backfill: { ...this.#bf } };
  }

  /** Runs the backfill loop while the state is "running"; resolves when drained, paused or cancelled. */
  drain(): Promise<void> {
    if (this.#loop) return this.#loop;
    this.#loop = (async () => {
      try {
        while (this.#bf.state === "running" && this.#queue.length > 0) {
          if (this.#o.budget && !(await this.#o.budget.canContinue())) { if (this.#bf.state === "running") this.#pause("budget"); break; }
          if (this.#bf.state !== "running") break;
          const next = this.#queue.shift()!;
          await this.index(next);
          this.#bf.done++;
        }
        if (this.#bf.state === "running" && this.#queue.length === 0) this.#bf.state = "done";
      } finally { this.#loop = null; }
    })();
    return this.#loop;
  }
  #pause(reason: "budget" | "user" | "error"): void { this.#bf.state = "paused"; this.#bf.pausedReason = reason; }

  backfill = {
    start: async (_opts: { reason: "enable" | "model-change" | "manual" }): Promise<void> => {
      if (this.#bf.state === "running") return;
      const queue: MediaIndexRequest[] = [];
      this.#bf = { state: "running", done: 0, total: 0, startedAt: (this.#o.now ?? (() => new Date().toISOString()))() };
      try { if (this.#o.listUnindexed) for await (const r of this.#o.listUnindexed()) queue.push(r); }
      catch { this.#pause("error"); return; }
      this.#queue = queue; this.#bf.total = queue.length;
      await this.drain();
    },
    pause: async (): Promise<void> => { if (this.#bf.state === "running") this.#pause("user"); },
    resume: async (): Promise<void> => {
      if (this.#bf.state !== "paused") return;
      this.#bf.state = "running"; delete this.#bf.pausedReason;
      await this.drain();
    },
    cancel: async (): Promise<void> => {
      if (this.#bf.state !== "running" && this.#bf.state !== "paused") return;
      this.#queue = []; this.#bf.state = "cancelled"; delete this.#bf.pausedReason;
    },
  };
}
