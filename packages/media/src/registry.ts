import { HttpImageAdapter, defaults } from './adapters.ts';
import type { HttpAdapterConfig } from './adapters.ts';
import { CoreMLAdapter } from './coreml.ts';
import type { CoreMLConfig } from './coreml.ts';
import { MediaError } from './types.ts';
import type { ImageAdapter, Capabilities, ImageRequest, GenerationContext, ImageResult } from './types.ts';
export type AdapterConfig = HttpAdapterConfig | CoreMLConfig;
export function createAdapter(config: AdapterConfig): ImageAdapter { return config.id === 'coreml-local' ? new CoreMLAdapter(config) : new HttpImageAdapter(config); }
export function egressHosts(configs: AdapterConfig[]): string[] {
  const hosts = new Set<string>();
  for (const config of configs) {
    createAdapter(config); // Apply identical configuration validation as the factory.
    if (config.id !== 'coreml-local') { hosts.add(new URL(config.baseUrl ?? defaults[config.id]).hostname); for (const host of config.downloadHosts ?? []) hosts.add(host); }
  }
  return [...hosts].sort();
}
export class AdapterRegistry {
  private readonly adapters: Map<string, ImageAdapter>;
  constructor(configs: AdapterConfig[]) {
    this.adapters = new Map(); for (const config of configs) { if (this.adapters.has(config.id)) throw new MediaError('unsupported_parameter'); this.adapters.set(config.id, createAdapter(config)); }
  }
  capabilities(): Record<string, Capabilities> { return Object.fromEntries([...this.adapters].map(([id, a]) => [id, a.capabilities()])); }
  select(capability: keyof Capabilities, order = [...this.adapters.keys()]): ImageAdapter {
    for (const id of order) { const adapter = this.adapters.get(id); if (adapter?.capabilities()[capability]) return adapter; }
    throw new MediaError('backend_unavailable');
  }
  selectVideo(operation: 'textToVideo' | 'imageToVideo' | 'videoToVideo', order = [...this.adapters.keys()]): ImageAdapter {
    for (const id of order) { const adapter = this.adapters.get(id); if (adapter?.capabilities().video?.[operation]) return adapter; }
    throw new MediaError('backend_unavailable');
  }
  /** Only transport unavailability may fall back. Policy, quota, timeout and cancellation never trigger another provider. */
  async generate(req: ImageRequest, order: string[], context: GenerationContext = {}): Promise<ImageResult> {
    for (const id of order) {
      const adapter = this.adapters.get(id); if (!adapter?.capabilities().generate || req.kind === 'video' && !adapter.capabilities().video?.textToVideo) continue;
      try { return await adapter.generate(req, context); } catch (e) { if (!(e instanceof MediaError) || e.code !== 'backend_unavailable') throw e; }
    }
    throw new MediaError('backend_unavailable');
  }
}
