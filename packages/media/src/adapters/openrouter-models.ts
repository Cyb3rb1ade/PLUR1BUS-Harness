import { MediaError } from '../types.ts';
/** OpenRouter models endpoint: https://openrouter.ai/docs/api-reference/list-available-models (architecture.output_modalities, pricing.image). */
export interface ImageModel { id: string; name?: string; edit: boolean; costPerImageUsd?: number }
const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
export function parseImageModels(doc: unknown): ImageModel[] {
  const out: ImageModel[] = []; const data = object(doc)?.data; if (!Array.isArray(data)) return out;
  for (const raw of data) {
    const item = object(raw); const arch = object(item?.architecture);
    if (!item || typeof item.id !== 'string' || !strings(arch?.output_modalities).includes('image')) continue;
    const price = Number(object(item.pricing)?.image);
    out.push({ id: item.id, ...(typeof item.name === 'string' ? { name: item.name } : {}), edit: strings(arch?.input_modalities).includes('image'), ...(Number.isFinite(price) && price > 0 ? { costPerImageUsd: price } : {}) });
  }
  return out;
}
export interface CatalogOptions { ttlMs?: number; failureBackoffMs?: number; now?: () => number }
/** Time-boxed cache of the image-capable models. A failed refresh serves the last good list instead of failing the caller. */
export class ModelCatalog {
  private cache: { at: number; models: ImageModel[] } | undefined; private retryAt = 0; private readonly ttl: number; private readonly backoff: number; private readonly now: () => number;
  private readonly fetchList: (signal: AbortSignal) => Promise<unknown>;
  constructor(fetchList: (signal: AbortSignal) => Promise<unknown>, options: CatalogOptions = {}) {
    this.ttl = options.ttlMs ?? 3_600_000; this.backoff = options.failureBackoffMs ?? 30_000; this.now = options.now ?? Date.now; this.fetchList = fetchList;
    if (!Number.isFinite(this.ttl) || this.ttl <= 0 || !Number.isFinite(this.backoff) || this.backoff < 0) throw new MediaError('unsupported_parameter');
  }
  invalidate(): void { this.cache = undefined; this.retryAt = 0; }
  async list(signal: AbortSignal): Promise<ImageModel[]> {
    const now = this.now();
    if (this.cache && (now - this.cache.at < this.ttl || now < this.retryAt)) return this.cache.models;
    try { const models = parseImageModels(await this.fetchList(signal)); this.cache = { at: this.now(), models }; return models; }
    catch (e) { if (this.cache && !signal.aborted) { this.retryAt = now + this.backoff; return this.cache.models; } throw e; }
  }
  async find(id: string, signal: AbortSignal): Promise<ImageModel | undefined> { return (await this.list(signal)).find(m => m.id === id); }
}
