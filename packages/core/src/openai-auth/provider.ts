import { AuthError } from '../auth/errors.ts';
import { randomUUID } from 'node:crypto';
import { createResponsesAdapter, createChatCompletionsAdapter, ProviderError, type StreamingAdapter } from '../../../providers/src/index.ts';
import type { ProviderDefinition } from '../composition/auth.ts';
import { RESOURCE, type PlanPrincipal } from './profiles.ts';
import type { AuthService } from './service.ts';
import type { PlanUsageStore } from './usage.ts';
import { FederatedCredential, type FederatedSource } from './federated.ts';
import { OpenAIError, type ErrorCode } from './ports.ts';
class D110AuthorizationError extends AuthError {
  readonly openAICode: ErrorCode;
  constructor(code: ErrorCode) { super('reauth_required', 'OpenAI authorization unavailable (' + code + ').'); this.openAICode = code; }
}
export interface OpenAIProviderBinding { credentialId?: string; person: string; deployment?: PlanPrincipal['deployment']; federated?: FederatedSource }
export function isOpenAIManaged(def: ProviderDefinition) { return def.profile.client_registration === 'dynamic_on_authorize' || def.profile.kind === 'federated_token'; }
/** The composition supplies authenticated person context. A profile cannot grant access to another person's plan. */
export function openAIAdapter(o: { definition: ProviderDefinition; auth: AuthService; usage: PlanUsageStore; fetch: typeof fetch; clock: () => number; currentPerson: () => string | undefined }): StreamingAdapter {
  const def = o.definition, plan = def.profile.kind !== 'federated_token', binding = def.openai;
  if (!binding?.person || (plan && !binding.credentialId) || (!plan && !binding.federated)) throw new OpenAIError('invalid-request');
  if (plan && def.profile.base_url !== undefined && def.profile.base_url !== RESOURCE) throw new OpenAIError('invalid-request');
  if (!['codex_responses','chat_completions'].includes(def.wireFormat)) throw new OpenAIError('siwc-unsupported');
  if (plan && def.wireFormat !== 'codex_responses') throw new ProviderError('invalid_request', 'Sign in with ChatGPT requires the Responses API; Chat Completions is unavailable.', { code: 'siwc-unsupported' });
  const federated = !plan ? new FederatedCredential(binding.federated!, o.clock) : undefined;
  return { async *stream(request, options) {
    const person = o.currentPerson();
    if (person !== binding.person) throw new ProviderError('auth', 'Plan credential belongs to a different person.', { code: 'owner-only', cause: new D110AuthorizationError('owner-only') });
    const principal: PlanPrincipal = { owner: binding.person, user: person, agentOwner: binding.person, deployment: binding.deployment ?? 'local' };
    const header = async () => {
      try {
        if (plan) { const models = await o.auth.models(binding.credentialId!, principal); if (!models.includes(request.model)) throw new OpenAIError('scope-denied'); }
        const token = plan ? await o.auth.lease(binding.credentialId!, principal) : await federated!.lease(); return 'Bearer ' + token.value();
      } catch (e) { throw new D110AuthorizationError(e instanceof OpenAIError ? e.code : 'auth-required'); }
    };
    const config = { baseUrl: def.profile.base_url ?? 'https://api.openai.com/v1', fetch: o.fetch, credentials: { authorization: header } };
    const adapter = def.wireFormat === 'codex_responses' ? createResponsesAdapter({ ...config, profile: plan ? 'chatgpt_plan' : 'openai' }) : createChatCompletionsAdapter(config);
    const callId = randomUUID();
    // maxTokens is the harness admission estimate; SIWC cannot send it. Explicit sampling params are refused by the adapter.
    const { maxTokens: _estimate, ...siwc } = request;
    try { for await (const event of adapter.stream(plan ? siwc : request, options)) {
      if (plan && event.type === 'done') o.usage.record(callId, person, binding.credentialId!, request.model, event.result.usage ?? {}, o.clock());
      yield event;
    } } catch (e) {
      if (e instanceof ProviderError && e.cause instanceof D110AuthorizationError) throw new ProviderError('auth', 'OpenAI credential unavailable; sign in again.', { code: e.cause.openAICode, cause: e.cause });
      throw e;
    }

  } };
}
