import type { ImageFormat } from '../types.ts';
/** Static description of what each adapter's protocol implements (not every model behind it). Mirrors docs/media-adapters.md. */
export interface AdapterProfile {
  id: string; location: 'remote' | 'local'; /** Provider job is submitted, polled and cancellable. */ async: boolean;
  /** Formats the request may ask for; empty = the provider decides and `format` is refused. */ formats: ImageFormat[];
  maxImages: number; sizes: 'free' | 'aspect' | 'model'; references: number; mask: boolean;
  /** True when the answer depends on the configured model (Replicate input schema, OpenRouter model list). */ modelDependent: boolean;
}
const profile = (p: AdapterProfile): AdapterProfile => p;
export const ADAPTER_PROFILES: Readonly<Record<string, AdapterProfile>> = {
  openai: profile({ id: 'openai', location: 'remote', async: false, formats: ['png', 'jpeg', 'webp'], maxImages: 10, sizes: 'free', references: 16, mask: true, modelDependent: false }),
  google: profile({ id: 'google', location: 'remote', async: false, formats: [], maxImages: 10, sizes: 'aspect', references: 16, mask: false, modelDependent: false }),
  xai: profile({ id: 'xai', location: 'remote', async: false, formats: [], maxImages: 10, sizes: 'aspect', references: 0, mask: false, modelDependent: false }),
  openrouter: profile({ id: 'openrouter', location: 'remote', async: false, formats: [], maxImages: 10, sizes: 'aspect', references: 16, mask: false, modelDependent: true }),
  replicate: profile({ id: 'replicate', location: 'remote', async: true, formats: ['png', 'jpeg', 'webp'], maxImages: 4, sizes: 'model', references: 1, mask: true, modelDependent: true }),
  fal: profile({ id: 'fal', location: 'remote', async: true, formats: ['png', 'jpeg'], maxImages: 4, sizes: 'free', references: 1, mask: true, modelDependent: true }),
  together: profile({ id: 'together', location: 'remote', async: false, formats: ['png', 'jpeg'], maxImages: 4, sizes: 'free', references: 0, mask: false, modelDependent: false }),
  'draw-things': profile({ id: 'draw-things', location: 'local', async: false, formats: [], maxImages: 10, sizes: 'free', references: 1, mask: false, modelDependent: false }),
  'coreml-local': profile({ id: 'coreml-local', location: 'local', async: false, formats: ['png'], maxImages: 10, sizes: 'model', references: 1, mask: false, modelDependent: false }),
};
export function adapterProfile(id: string): AdapterProfile | undefined { return ADAPTER_PROFILES[id]; }
