// L14: a per-model EWMA in session storage; transcript rows remain immutable.
import type { SessionStore } from './store.ts';
export interface ContextModel { provider: string; model: string }
export interface ReadCatalog { read(): { models: readonly { provider: string; id: string; contextWindow?: number }[] } }
export function catalogWindow(catalog: ReadCatalog, model: ContextModel): number | undefined {
  const window = catalog.read().models.find(m => m.provider === model.provider && m.id === model.model)?.contextWindow;
  return window !== undefined && Number.isSafeInteger(window) && window > 0 ? window : undefined;
}
export class TokenMeter {
  readonly #store: SessionStore;
  constructor(store: SessionStore) { this.#store = store; }
  count(model: string, text: string, measured?: number): number {
    if (measured !== undefined && Number.isSafeInteger(measured) && measured >= 0) return measured;
    return Math.ceil(Math.ceil(text.length / 4) * this.#store.tokenFactor(model));
  }
  observe(model: string, estimated: number, measured: number): void {
    if (!model || !Number.isFinite(estimated) || estimated <= 0 || !Number.isSafeInteger(measured) || measured <= 0) return;
    const ratio = Math.min(16, Math.max(.25, measured / estimated));
    const prior = this.#store.tokenCalibration(model);
    this.#store.setTokenFactor(model, prior === null ? ratio : .8 * prior + .2 * ratio);
  }
}
