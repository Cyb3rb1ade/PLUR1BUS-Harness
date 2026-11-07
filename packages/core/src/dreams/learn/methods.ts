import { authenticatedPrincipal } from '../../rbac/guard.ts';
import type { Handler } from '../../rpc/server.ts';
import { RpcError } from '../../rpc/errors.ts';
import type { LearnService } from './service.ts';
import type { Target } from './types.ts';
export const LEARN_METHODS = ['dreams.learn.run', 'dreams.learn.status', 'dreams.learn.list', 'dreams.learn.get', 'dreams.learn.decide', 'dreams.learn.rollback', 'dreams.learn.calibration'] as const;
/** The nested dispatch must be Core's guarded public dispatch, not the raw MemoryOps handlers. */
export function learnMethods(service: () => LearnService | null, dispatch: (method: string) => Handler): Record<string, Handler> {
  return Object.fromEntries(LEARN_METHODS.map(method => [method, (async (params, ctx) => {
    const s = service(); if (!s) throw new RpcError('E_NOT_AVAILABLE', 'Learning store unavailable', { reason: 'learn-store-unavailable' });
    const person = authenticatedPrincipal(ctx);
    if (person.kind !== 'person') throw new RpcError('E_DENIED', 'Human review required', { reason: 'human-only' });
    const p = params as { offset?: number; scope: Target['scope']; agentId: string; projectId?: string; id: string; contentHash: string; outcome: 'accepted' | 'rejected'; staleAction?: 'correct' | 'forget' };
    const target: Target = { scope: p.scope, owner: person.userId, agentId: p.agentId, ...(p.projectId ? { projectId: p.projectId } : {}) };
    const call = async (name: string, input: Record<string, unknown>) => dispatch(name)(input, ctx);
    switch (method) {
      case 'dreams.learn.run': return { run: await s.run(target, person, ctx.signal) };
      case 'dreams.learn.status': return { status: s.status(target, person) };
      case 'dreams.learn.list': return s.list(target, person, p.offset);
      case 'dreams.learn.get': return s.get(p.id, person);
      case 'dreams.learn.decide': return s.decide(p, person, call);
      case 'dreams.learn.rollback': return { result: await s.rollback(p.id, person, call) };
      case 'dreams.learn.calibration': return { record: s.calibration(target, person) };
    }
  }) satisfies Handler]));
}
