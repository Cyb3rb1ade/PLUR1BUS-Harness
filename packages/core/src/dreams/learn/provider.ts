import { createEngineCompletion } from '../../engine/llm.ts';
import { createTurnProvider, type TurnProviderOptions } from '../../composition/provider.ts';
import { deriveUserPrincipal } from '../../identity/principals.ts';
import { RpcError } from '../../rpc/errors.ts';
import { LearnError } from './types.ts';
import type { LearnModel } from './model.ts';

/** Dedicated tool-free background route; no session-role factory, Jev, Kev or triage invocation. */
export function learningModel(o: TurnProviderOptions | null, sharedLocalOnly: () => boolean, create = createTurnProvider): LearnModel {
  const agent = o ? createEngineCompletion(create, o) : null;
  const project = o ? createEngineCompletion(create, { ...o, localOnly: sharedLocalOnly }) : null;
  return { async complete(request) {
    const complete = request.target.scope === 'project' ? project : agent;
    if (!complete || !o) throw new LearnError('no-model');
    const profile = o.profileForClass?.(request.modelClass);
    if (!profile || !Object.hasOwn(o.profiles, profile) || !o.profiles[profile]?.length) throw new LearnError('no-model');
    try {
      const result = await complete(request.target.agentId, { model: profile, maxTokens: request.maxOutputTokens,
        messages: [{ role: 'system', content: request.instructions }, { role: 'user', content: request.data }], signal: request.signal },
      { principal: deriveUserPrincipal(request.target.owner), ...(request.target.projectId ? { projectId: request.target.projectId } : {}) });
      if (!result.model || !result.usage || typeof result.usage.inputTokens !== 'number' || typeof result.usage.outputTokens !== 'number') throw new LearnError('provider-failed');
      return { text: result.text, model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
    } catch (error) {
      if (error instanceof LearnError) throw error;
      if (error instanceof RpcError && error.reason === 'budget-exceeded') throw new LearnError('budget');
      if (error instanceof RpcError && error.reason === 'local-only') throw new LearnError('local-only');
      throw new LearnError('provider-failed');
    }
  } };
}
