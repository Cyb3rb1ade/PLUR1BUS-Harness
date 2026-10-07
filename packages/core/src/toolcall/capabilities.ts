import { CATEGORY_PREFIX } from './categories.ts';
import type { Effect } from '../policy/effects.ts';
import type { Risk } from '../policy/capabilities.ts';
export type CapabilityKind = 'tool' | 'skill' | 'mcp-tool' | 'extension' | 'plugin-command' | 'channel-action';
export interface CapabilityEntry {
  id: string; name: string; description: string; category: string; secondaryCategories?: readonly string[];
  kind: CapabilityKind; effect: Effect; risk: Risk; source: string; version: string;
  useWhen?: string; notFor?: string; inputs?: string; enabled?: boolean;
}
export interface SearchFilters { category?: string; kind?: CapabilityKind; effect?: Effect; source?: string; limit?: number }
export interface SearchHit { entry: CapabilityEntry; score: number; reasons: string[] }
export interface EmbeddingPort { score(query: string, entries: readonly CapabilityEntry[]): ReadonlyMap<string, number> }
export interface RegistrationPort { snapshot(): readonly CapabilityEntry[]; subscribe(change: (event: { upsert?: CapabilityEntry; remove?: string }) => void): () => void }
const tokens = (s: string): string[] => s.toLocaleLowerCase('en').match(/[\p{L}\p{N}_]+/gu) ?? [];
const textOf = (e: CapabilityEntry): string => `${e.name} ${e.description} ${e.category} ${e.useWhen ?? ''} ${e.inputs ?? ''}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** Library index; persistence and policy filtering are supplied by the registration/embedding ports. */
export class CapabilityIndex {
  readonly #entries = new Map<string, CapabilityEntry>();
  #revision = 0;
  #last: { key: string; items: SearchHit[]; hint?: string } | undefined;
  readonly #embedding: EmbeddingPort | undefined;
  constructor(embedding?: EmbeddingPort) { this.#embedding = embedding; }
  upsert(entry: CapabilityEntry): void {
    if (!entry.id || !entry.name || !entry.description || !entry.version || !entry.source || !['tool', 'skill', 'mcp-tool', 'extension', 'plugin-command', 'channel-action'].includes(entry.kind) || !['read', 'local-write', 'local-destructive', 'external', 'money'].includes(entry.effect) || !['low', 'medium', 'high', 'critical'].includes(entry.risk) || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(entry.category) || (entry.secondaryCategories?.length ?? 0) > 2) throw Error('invalid capability entry');
    const copy = structuredClone(entry); Object.freeze(copy.secondaryCategories); Object.freeze(copy);
    this.#entries.set(entry.id, copy); this.#revision++;
  }
  remove(id: string): void { if (this.#entries.delete(id)) this.#revision++; }
  connect(port: RegistrationPort): () => void { for (const entry of port.snapshot()) this.upsert(entry); return port.subscribe(e => { if (e.upsert) this.upsert(e.upsert); if (e.remove) this.remove(e.remove); }); }
  categoriesPrefix(): string { return CATEGORY_PREFIX; }
  search(query: string, filters: SearchFilters = {}): SearchHit[] {
    const limit = filters.limit ?? 12; if (!Number.isSafeInteger(limit) || limit < 0 || limit > 128) throw Error('search limit must be 0..128');
    const entries = [...this.#entries.values()].filter(e => e.enabled !== false && (!filters.category || e.category === filters.category || e.secondaryCategories?.includes(filters.category)) && (!filters.kind || e.kind === filters.kind) && (!filters.effect || e.effect === filters.effect) && (!filters.source || e.source === filters.source));
    const docs = entries.map(e => tokens(textOf(e))); const average = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1);
    const terms = [...new Set(tokens(query))]; const semantic = this.#embedding?.score(query, entries);
    return entries.map((entry, i): SearchHit => {
      const doc = docs[i]!; let score = 0; const reasons: string[] = [];
      for (const term of terms) {
        const tf = doc.filter(t => t === term).length; if (!tf) continue;
        const df = docs.filter(d => d.includes(term)).length;
        score += Math.log(1 + (docs.length - df + .5) / (df + .5)) * tf * 2.2 / (tf + 1.2 * (.25 + .75 * doc.length / (average || 1)));
        reasons.push(`lexical:${term}`);
      }
      const embedding = semantic?.get(entry.id); if (embedding !== undefined && Number.isFinite(embedding) && embedding > 0) { score += embedding; reasons.push('embedding'); }
      if (!reasons.length) reasons.push('fallback:no lexical overlap');
      if (filters.category) reasons.push(`category:${filters.category}`);
      return { entry, score, reasons };
    }).sort((a, b) => b.score - a.score || compare(a.entry.id, b.entry.id)).slice(0, limit);
  }
  route(query: string, distribution: Readonly<Record<string, number>>, topK = 12, confidence = 1): { items: SearchHit[]; cached: boolean; hint?: string } {
    if (!Number.isSafeInteger(topK) || topK < 0 || topK > 128) throw Error('routing budget must be 0..128');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw Error('invalid confidence');
    if (Object.values(distribution).some(p => !Number.isFinite(p) || p < 0)) throw Error('invalid category distribution');
    const categories = Object.entries(distribution).sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).slice(0, 3);
    if (categories.some(([, p]) => !Number.isFinite(p) || p < 0) || !categories.length || categories.reduce((n, [, p]) => n + p, 0) <= 0) throw Error('invalid category distribution');
    const key = JSON.stringify([this.#revision, query, categories, topK, confidence]);
    if (this.#last?.key === key) return { items: structuredClone(this.#last.items), cached: true, ...(this.#last.hint ? { hint: this.#last.hint } : {}) };
    const sum = categories.reduce((n, [, p]) => n + p, 0);
    const quotas = categories.map(([category, p]) => ({ category, quota: Math.floor(topK * p / sum), remainder: topK * p / sum % 1 }));
    let spare = topK - quotas.reduce((n, q) => n + q.quota, 0);
    for (const q of [...quotas].sort((a, b) => b.remainder - a.remainder)) if (spare-- > 0) q.quota++;
    if (confidence < .5 && topK >= quotas.length) for (const q of quotas) if (q.quota === 0) { const donor = [...quotas].sort((a, b) => b.quota - a.quota)[0]!; if (donor.quota > 1) { donor.quota--; q.quota++; } }
    const selected = new Map<string, SearchHit>();
    for (const q of quotas) for (const hit of this.search(query, { category: q.category, limit: q.quota })) selected.set(hit.entry.id, hit);
    if (selected.size < topK) for (const hit of this.search(query, { limit: 128 })) { if (selected.size === topK) break; if (!selected.has(hit.entry.id)) selected.set(hit.entry.id, hit); }
    const items = [...selected.values()]; const hint = confidence < .5 ? 'Low confidence: use capabilities.search to discover alternatives.' : undefined;
    this.#last = { key, items, ...(hint ? { hint } : {}) }; return { items: structuredClone(items), cached: false, ...(hint ? { hint } : {}) };
  }
}
/** Method-shaped library surface, independent of RPC schemas and RBAC. */
export function capabilitiesSearch(index: CapabilityIndex, query: string, filters?: SearchFilters): SearchHit[] { return index.search(query, filters); }
