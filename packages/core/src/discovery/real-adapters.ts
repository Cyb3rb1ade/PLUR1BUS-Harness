// Read-only D15/D110 adapters. Values are released only as origin-bound, non-serializable leases.
import { inspect } from 'node:util';
import { createCredentialsProvider, AuthError, HttpRefresher, createOAuthHttp } from '../auth/index.ts';
import type { SecretStore } from '../auth/secret-store.ts';
import type { ProviderDefinition } from '../composition/auth.ts';
import type { AuthService } from '../openai-auth/service.ts';
import { RESOURCE } from '../openai-auth/profiles.ts';
import type { Egress } from '../egress/service.ts';
import { CredentialUnavailableError, type CredentialLease, type ProfileInfo } from './ports.ts';
import { parseBaseUrl, ScanError } from './http.ts';

export type DiscoveryProviderDefinition = ProviderDefinition & { discovery?: "ollama-tags"; vendor?: string };

export interface RealAdapterDeps {
  definitions: () => Readonly<Record<string, DiscoveryProviderDefinition>>;
  store: SecretStore;
  egress: Egress;
  now: () => number;
  openai: () => Pick<AuthService, 'lease'> | undefined;
  /** Core supplies its existing credential pool/refresh owner; standalone port tests may omit it. */
  credentialProvider?: (definition: ProviderDefinition) => import("../auth/credentials.ts").CredentialsProvider | undefined;
}
function profileInfo(id: string, def: DiscoveryProviderDefinition): ProfileInfo {
  const p = def.profile;
  const plan = p.client_registration === 'dynamic_on_authorize';
  const baseUrl = p.base_url ?? (plan ? RESOURCE : def.wireFormat === 'anthropic_messages' ? 'https://api.anthropic.com/v1' : def.wireFormat === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1');
  // D110's direct SIWC resource explicitly supports GET /models. No backend/CLI endpoint is inferred.
  const manual = !['chat_completions', 'anthropic_messages', 'gemini', 'codex_responses'].includes(def.wireFormat) ||
    (def.discovery === 'ollama-tags' && !plan && def.wireFormat !== 'chat_completions') || p.policy_status !== 'allowed' || p.kind === 'external_cli' || p.kind === 'federated_token' || p.kind === 'adc' ||
    (plan && (baseUrl !== RESOURCE || !def.openai?.credentialId || !def.openai.person)) || (!plan && def.wireFormat === 'codex_responses');
  const discovery = manual ? 'manual' : plan ? 'openai-models' : def.discovery === 'ollama-tags' ? 'ollama-tags' : def.wireFormat === 'anthropic_messages' ? 'anthropic-models' : def.wireFormat === 'gemini' ? 'google-models' : 'openai-models';
  return { id, baseUrl, discovery, vendor: def.vendor ?? (discovery === 'ollama-tags' ? 'ollama' : def.wireFormat === 'anthropic_messages' ? 'anthropic' : def.wireFormat === 'gemini' ? 'google' : 'openai') };
}
function protectedLease(origin: string, headerName: string, headerValue: string): CredentialLease {
  return Object.defineProperties({ origin, headerName }, {
    headerValue: { get: () => headerValue },
    toJSON: { value: () => ({ origin, headerName, headerValue: '[redacted]' }) },
    [inspect.custom]: { value: () => '[DiscoveryCredentialLease]' },
  }) as CredentialLease;
}
export function createRealDiscoveryAdapters(d: RealAdapterDeps) {
  return {
    profiles: { list: (): readonly ProfileInfo[] => Object.entries(d.definitions()).filter(([, def]) => !!def?.profile).map(([id, def]) => profileInfo(id, def)) },
    credentials: { async resolve(id: string, origin: string): Promise<CredentialLease | null> {
      const def = d.definitions()[id];
      if (!def?.profile) throw new CredentialUnavailableError('no_credential');
      const info = profileInfo(id, def);
      if (parseBaseUrl(info.baseUrl).origin !== origin) throw new ScanError('failed:invalid', 'credential_origin_mismatch');
      if (info.discovery === 'manual') throw new CredentialUnavailableError('no_credential');
      if (info.discovery === 'ollama-tags' && !def.profile.secret_ref && def.entries.length === 0) return null;
      if (def.profile.client_registration === 'dynamic_on_authorize') {
        const auth = d.openai(), binding = def.openai;
        if (!auth || !binding?.credentialId) throw new CredentialUnavailableError('no_credential');
        try {
          const token = await auth.lease(binding.credentialId, { user: binding.person, owner: binding.person, agentOwner: binding.person, deployment: binding.deployment ?? 'local' });
          return protectedLease(origin, 'Authorization', 'Bearer ' + token.value());
        } catch { throw new CredentialUnavailableError('renew_sign_in'); }
      }
      const shared = d.credentialProvider?.(def);
      if (d.credentialProvider && !shared) throw new CredentialUnavailableError("no_credential");
      const credentials = shared ?? createCredentialsProvider({ profiles: [def], store: d.store, clock: { now: d.now }, refresher: new HttpRefresher(createOAuthHttp({ egress: d.egress })) });
      try {
        const lease = await credentials.getAuthorization({ profileId: def.profile.id });
        return protectedLease(origin, lease.header.name, lease.header.value);
      } catch (e) {
        throw new CredentialUnavailableError(e instanceof AuthError && e.code === 'reauth_required' ? 'renew_sign_in' : 'no_credential');
      } finally { if (!shared && "close" in credentials) (credentials as ReturnType<typeof createCredentialsProvider>).close(); }
    } },
  };
}
