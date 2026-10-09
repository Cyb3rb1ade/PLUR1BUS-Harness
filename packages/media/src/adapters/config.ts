import type { AdapterConfig } from '../registry.ts';
import type { HttpAdapterConfig } from '../adapters.ts';
import type { CoreMLConfig, ComputeUnits } from '../coreml.ts';
import { privateHost } from '../http.ts';
/** `media.adapters.*` as validated by config-schema. Secret *references* only; values come from `resolveSecret` (the core's secret store). */
export interface MediaAdapterSettings { adapters?: Record<string, Record<string, unknown> | undefined> }
export type SkipReason = 'disabled' | 'no_key' | 'key_unresolved' | 'no_model' | 'no_binary' | 'lan_not_allowed';
export interface Skipped { id: string; reason: SkipReason }
/** Defaults checked against vendor documentation on 2026-10-08; the same ids are the schema defaults (a test keeps them equal). */
export const DEFAULT_MODELS = {
  openai: 'gpt-image-2.5-sunburst', google: 'gemini-nano-banana-2.1', xai: 'grok-imagine-image-2.0', openrouter: 'google/gemini-2.5-flash-image',
  replicate: 'black-forest-labs/flux-schnell', fal: 'fal-ai/flux/schnell', together: 'black-forest-labs/FLUX.2-dev',
} as const;
const REMOTE = ['openai', 'google', 'xai', 'openrouter', 'replicate', 'fal', 'together'] as const;
const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v : undefined;
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
export async function adapterConfigsFromSettings(settings: MediaAdapterSettings | undefined, resolveSecret: (ref: string) => Promise<string | undefined>): Promise<{ configs: AdapterConfig[]; skipped: Skipped[] }> {
  const configs: AdapterConfig[] = []; const skipped: Skipped[] = []; const all = settings?.adapters ?? {};
  const skip = (id: string, reason: SkipReason) => { skipped.push({ id, reason }); };
  const common = (s: Record<string, unknown>) => ({ ...(str(s.baseUrl) ? { baseUrl: str(s.baseUrl)! } : {}), ...(num(s.timeoutMs) === undefined ? {} : { timeoutMs: num(s.timeoutMs)! }), ...(num(s.maxConcurrent) === undefined ? {} : { maxConcurrent: num(s.maxConcurrent)! }) });
  for (const id of REMOTE) {
    const s = all[id]; if (!s) continue;
    if (s.enabled === false) { skip(id, 'disabled'); continue; }
    const ref = str(s.apiKeyRef); if (!ref) { skip(id, 'no_key'); continue; }
    const key = (await resolveSecret(ref))?.trim(); if (!key) { skip(id, 'key_unresolved'); continue; }
    configs.push({ id, model: str(s.model) ?? DEFAULT_MODELS[id], apiKey: key, ...common(s) } satisfies HttpAdapterConfig);
  }
  const dt = all.drawthings;
  if (dt) {
    if (dt.enabled !== true) skip('draw-things', 'disabled');
    else if (!str(dt.model)) skip('draw-things', 'no_model');
    else {
      const host = str(dt.host) ?? '127.0.0.1'; const port = num(dt.port) ?? 7860; const bare = host.replace(/^\[|\]$/g, ''); const loopback = bare === 'localhost' || bare === '::1' || /^127\./.test(bare);
      if (!loopback && dt.allowLan !== true) skip('draw-things', 'lan_not_allowed');
      else if (!privateHost(bare) && !loopback) skip('draw-things', 'lan_not_allowed');
      else configs.push({ id: 'draw-things', model: str(dt.model)!, baseUrl: `http://${bare.includes(':') ? `[${bare}]` : bare}:${port}`, ...(loopback ? {} : { allowLan: true }), ...(num(dt.timeoutMs) === undefined ? {} : { timeoutMs: num(dt.timeoutMs)! }), ...(num(dt.maxConcurrent) === undefined ? {} : { maxConcurrent: num(dt.maxConcurrent)! }) });
    }
  }
  const cm = all.coreml;
  if (cm) {
    if (cm.enabled !== true) skip('coreml-local', 'disabled');
    else if (!str(cm.binary)) skip('coreml-local', 'no_binary');
    else if (!str(cm.model)) skip('coreml-local', 'no_model');
    else {
      const units = str(cm.computeUnits); const config: CoreMLConfig = { id: 'coreml-local', model: str(cm.model)!, helperPath: str(cm.binary)! };
      if (str(cm.modelsDir)) config.modelDir = str(cm.modelsDir)!;
      if (units && units !== 'auto') config.computeUnits = units as ComputeUnits;
      if (str(cm.scheduler)) config.scheduler = str(cm.scheduler)!;
      if (num(cm.timeoutMs) !== undefined) config.timeoutMs = num(cm.timeoutMs)!;
      configs.push(config);
    }
  }
  return { configs, skipped };
}
