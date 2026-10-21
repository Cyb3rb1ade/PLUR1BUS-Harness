import { createHash } from 'node:crypto';
import { safeId } from '../../../media/src/files.ts';
import { mediaError } from './errors.ts';
import type { AudioDecoderPort, BudgetCallback, CaptionSource, FrameExtractorPort, MediaHit, MediaIndexPort, MediaIndexRequest, MediaIndexStatus, MediaSearchRequest, Scope } from './types.ts';

/** Host construction consumes these ports; Engine 1.19 has no attachHost method. */
export interface MediaHostPorts { frames: FrameExtractorPort | null; audio: AudioDecoderPort | null; budget?: BudgetCallback }
export interface EngineMediaScope { agentId: string; scope: 'agent-private' }
type EngineMediaStatus = Omit<MediaIndexStatus, 'provider' | 'model' | 'dim' | 'backfill'> & { provider: string | null; model: string | null; dim: number | null; backfill: Omit<MediaIndexStatus['backfill'], 'state' | 'startedAt'> & { state: MediaIndexStatus['backfill']['state'] | 'completed'; startedAt?: number } };
/** Public Engine 1.19 subset, declared locally until the Controller updates the dependency pin. */
export interface EngineMedia {
  index(req: Omit<MediaIndexRequest, 'scope' | 'encodingVideoSeconds'> & { scope: EngineMediaScope }): ReturnType<MediaIndexPort['index']>;
  search(req: Omit<MediaSearchRequest, 'scope'> & { scope: EngineMediaScope }): Promise<MediaHit[]>;
  remove(id: string): Promise<void>;
  setCaption(id: string, text: string, source: CaptionSource): Promise<void>;
  status(): EngineMediaStatus | Promise<EngineMediaStatus>;
  backfill: MediaIndexPort['backfill'];
}
const isFn = (v: unknown): boolean => typeof v === 'function';
/** Detect the public media feature, never an assumed contract version. */
export function detectEngineMedia(engine: unknown): boolean {
  if (typeof engine !== 'object' || engine === null) return false;
  const media = (engine as { media?: unknown }).media as Record<string, unknown> | null | undefined;
  if (typeof media !== 'object' || media === null) return false;
  if (!['index', 'search', 'remove', 'setCaption', 'status'].every(k => isFn(media[k]))) return false;
  const b = media['backfill'] as Record<string, unknown> | null | undefined;
  return typeof b === 'object' && b !== null && ['start', 'pause', 'resume', 'cancel'].every(k => isFn(b[k]));
}
const prefix = (scope: Scope) => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(scope.agentId) || typeof scope.workspace !== 'string' || !scope.workspace) throw mediaError('E_MEDIA_UNAVAILABLE', 'trusted media scope is missing');
  return `hm1:${scope.agentId}:${createHash('sha256').update(scope.workspace).digest('hex').slice(0,32)}:`;
};
/** Translate the Harness principal/port into the actual trusted Engine 1.19 boundary. */
export class EngineMediaIndex implements MediaIndexPort {
  readonly #m: EngineMedia;
  readonly #scopeOfMedia: (id: string) => Promise<Scope>;
  constructor(media: EngineMedia, options: { scopeOfMedia?: (id: string) => Promise<Scope> } = {}) {
    this.#m = media;
    this.#scopeOfMedia = options.scopeOfMedia ?? (async () => { throw mediaError('E_MEDIA_UNAVAILABLE', 'media ownership resolver unavailable'); });
  }
  index: MediaIndexPort['index'] = req => { const { encodingVideoSeconds: _units, ...input } = req; return this.#m.index({ ...input, mediaId: prefix(req.scope) + safeId(req.mediaId), scope: { agentId: req.scope.agentId, scope: 'agent-private' } }); };
  search: MediaIndexPort['search'] = async req => {
    const p = prefix(req.scope);
    if (req.likeMediaId !== undefined && prefix(await this.#scopeOfMedia(safeId(req.likeMediaId))) !== p) return [];
    const hits = await this.#m.search({ ...req, ...(req.likeMediaId ? { likeMediaId: p + safeId(req.likeMediaId) } : {}), scope: { agentId: req.scope.agentId, scope: 'agent-private' } });
    return hits.filter(hit => hit.mediaId.startsWith(p)).map(hit => ({ ...hit, mediaId: safeId(hit.mediaId.slice(p.length)) }));
  };
  remove: MediaIndexPort['remove'] = async id => this.#m.remove(prefix(await this.#scopeOfMedia(safeId(id))) + id);
  setCaption: MediaIndexPort['setCaption'] = async (id, text, source) => this.#m.setCaption(prefix(await this.#scopeOfMedia(safeId(id))) + id, text, source);
  status: MediaIndexPort['status'] = async () => {
    const s = await this.#m.status();
    const { startedAt, ...backfill } = s.backfill;
    return { ...s, provider: s.provider ?? '', model: s.model ?? '', dim: s.dim ?? 0,
      backfill: { ...backfill, state: s.backfill.state === 'completed' ? 'done' : s.backfill.state,
        ...(startedAt === undefined ? {} : { startedAt: new Date(startedAt).toISOString() }) } };
  };
  backfill: MediaIndexPort['backfill'] = {
    start: opts => this.#m.backfill.start(opts), pause: () => this.#m.backfill.pause(),
    resume: () => this.#m.backfill.resume(), cancel: () => this.#m.backfill.cancel(),
  };
}
