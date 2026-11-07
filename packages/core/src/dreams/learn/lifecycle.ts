import type { Handler } from '../../rpc/server.ts';
import type { LearnService } from './service.ts';

/** Runs inside the existing RPC authorization boundary, after the original mutation commits. */
export function learningLifecycle(methods: Record<string, Handler>, learn: () => LearnService | null,
  linkOwner: (linkId: string) => string | undefined): Record<string, Handler> {
  const result = { ...methods };
  for (const name of ['session.erase', 'agent.close', 'agent.archive', 'agent.delete', 'project.archive', 'project.agent.remove', 'project.member.remove', 'user.disable', 'user.role.set', 'agent.rights.set', 'identity.link.remove']) {
    const inner = methods[name]; if (!inner) continue;
    result[name] = async (params, ctx) => {
      const owner = name === 'identity.link.remove' ? linkOwner(params.linkId) : undefined;
      const value = await inner(params, ctx);
      learn()?.reconcile({ ...(['agent.close', 'agent.archive', 'agent.delete'].includes(name) ? { agentId: params.agentId as string } : {}), ...(owner ? { owner } : {}) });
      return value;
    };
  }
  return result;
}
