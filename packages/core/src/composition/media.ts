import { createAdapter, defaults, OutputStore, MediaError, type AdapterConfig, type ImageAdapter, type GenerationContext, type ImageRequest } from '../../../media/src/index.ts';
import type { SecretStore } from '../secrets/store.ts';
import { createAuthSecretStore } from '../auth/secret-store.ts';
import type { Egress } from '../egress/service.ts';
import { join } from 'node:path';
import { isLocalEndpoint, localOnlyDenied } from '../privacy/local-only.ts';
import { turnContext } from './context.ts';
import { deferMaintenanceStart, type CompositionMaintenance } from './maintenance.ts';

/** privacy.localOnly for media generation: read at operation time, per agent when the call runs inside a turn. */
export interface MediaPrivacy { localOnly: (agentId?: string) => boolean; localEndpoints: () => readonly string[] }

export type MediaDefinition = AdapterConfig & { secretRef?: string };
/** Credentials are leased at operation time; config contains references only. Native media transport retains its host/redirect checks. */
export async function composeMedia(home: string, configs: readonly MediaDefinition[], secrets: SecretStore, egress: Egress, registerSecret?: (value: string) => void, privacy?: MediaPrivacy, maintenance?: CompositionMaintenance) {
  if (!configs.length) return null;
  const definition = configs[0]!;
  if ('apiKey' in definition) throw new MediaError('unsupported_parameter');
  const { secretRef, ...config } = definition;
  const capabilities = createAdapter(config).capabilities();
  const secretPort = createAuthSecretStore(secrets);
  const endpoints = () => config.id === 'coreml-local' ? [] : [config.baseUrl ?? defaults[config.id], ...(config.downloadHosts ?? []).map(host => `https://${host}/`)];
  /** Local: the on-device adapter, or every endpoint it talks to (generation and downloads) is loopback or listed. */
  const local = () => endpoints().every(u => typeof u === 'string' && isLocalEndpoint(u, privacy?.localEndpoints() ?? []));
  const run = async (operation: 'generate' | 'edit', request: ImageRequest, context?: GenerationContext) => {
    context?.signal?.throwIfAborted();
    const urls = endpoints();
    // Before egress, secrets or any I/O: a cloud adapter is refused while local-only applies, never swapped for another.
    if (privacy?.localOnly(turnContext.getStore()?.agentId) && !local()) throw localOnlyDenied(`media adapter ${config.id}`, urls.find(u => !isLocalEndpoint(u, privacy.localEndpoints())));
    for (const url of urls) {
      const allowed = await egress.decide(url);
      // A cancel that lands while egress decides stops here: no further host is asked and no secret is leased.
      context?.signal?.throwIfAborted();
      if (!allowed.allowed) throw new MediaError('backend_unavailable');
    }
    const key = secretRef ? await secretPort.get(secretRef) : undefined;
    if (secretRef && key === undefined) throw new MediaError('backend_unavailable');
    if (key !== undefined) registerSecret?.(key);
    context?.signal?.throwIfAborted();
    const adapter = createAdapter({ ...config, ...(key === undefined ? {} : { apiKey: key }) } as AdapterConfig);
    return adapter[operation](request, context);
  };
  const adapter: ImageAdapter = { id: config.id, model: config.model, capabilities: () => capabilities, generate: (request, context) => run('generate', request, context), edit: (request, context) => run('edit', request, context) };
  const store = new OutputStore(join(home, 'media', 'outputs'));
  const unwatch = deferMaintenanceStart(maintenance, () => store.recoverStaging());
  if (!unwatch) await store.recoverStaging();
  return { adapter, store, local, close: () => unwatch?.() };
}
