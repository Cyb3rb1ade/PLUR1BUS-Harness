import { createAdapter, defaults, OutputStore, MediaError, type AdapterConfig, type ImageAdapter, type GenerationContext, type ImageRequest } from '../../../media/src/index.ts';
import type { SecretStore } from '../secrets/store.ts';
import { createAuthSecretStore } from '../auth/secret-store.ts';
import type { Egress } from '../egress/service.ts';
import { join } from 'node:path';

export type MediaDefinition = AdapterConfig & { secretRef?: string };
/** Credentials are leased at operation time; config contains references only. Native media transport retains its host/redirect checks. */
export async function composeMedia(home: string, configs: readonly MediaDefinition[], secrets: SecretStore, egress: Egress) {
  if (!configs.length) return null;
  const definition = configs[0]!;
  if ('apiKey' in definition) throw new MediaError('unsupported_parameter');
  const { secretRef, ...config } = definition;
  const capabilities = createAdapter(config).capabilities();
  const secretPort = createAuthSecretStore(secrets);
  const run = async (operation: 'generate' | 'edit', request: ImageRequest, context?: GenerationContext) => {
    context?.signal?.throwIfAborted();
    const urls = config.id === 'coreml-local' ? [] : [config.baseUrl ?? defaults[config.id], ...(config.downloadHosts ?? []).map(host => `https://${host}/`)];
    for (const url of urls) {
      const allowed = await egress.decide(url);
      if (!allowed.allowed) throw new MediaError('backend_unavailable');
    }
    const key = secretRef ? await secretPort.get(secretRef) : undefined;
    if (secretRef && key === undefined) throw new MediaError('backend_unavailable');
    context?.signal?.throwIfAborted();
    const adapter = createAdapter({ ...config, ...(key === undefined ? {} : { apiKey: key }) } as AdapterConfig);
    return adapter[operation](request, context);
  };
  const adapter: ImageAdapter = { id: config.id, model: config.model, capabilities: () => capabilities, generate: (request, context) => run('generate', request, context), edit: (request, context) => run('edit', request, context) };
  const store = new OutputStore(join(home, 'media', 'outputs'));
  await store.recoverStaging();
  return { adapter, store };
}
