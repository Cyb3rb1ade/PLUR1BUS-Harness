import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CompositionDeps } from '../../composition/index.ts';
import type { TurnProviderOptions, createTurnProvider } from '../../composition/provider.ts';
import type { SessionService } from '../../session/service.ts';
import type { Collab } from '../../collab/service.ts';
import type { ChatRequest } from '../../session/provider.ts';
import { ToolRegistry } from '../../tools/registry.ts';
import { ToolDispatcher } from '../../tools/dispatcher.ts';
import { readRights } from '../../memory-exposure/index.ts';
import { deriveUserPrincipal } from '../../identity/principals.ts';
import { callerToPrincipal } from '../../principal.ts';
import { localOnlyShared } from '../../privacy/local-only.ts';
import { LearnStore } from './store.ts';
import { LearnService } from './service.ts';
import { learningSource } from './source.ts';
import { learningModel } from './provider.ts';
import type { LearnReadPort } from './verify.ts';

export function composeLearning(d: CompositionDeps, options: TurnProviderOptions | null, sessions: SessionService, collab: Collab | null,
  toolsForTurn: (request: ChatRequest) => Promise<ToolRegistry>, create: typeof createTurnProvider): LearnService {
  const project = (id: string) => collab?.boardProject(id) ?? null;
  const source = learningSource(sessions.store, { config: d.config, hasAgent: id => d.agents.has(id), project, identity: () => d.identity });
  return new LearnService({ store: new LearnStore(join(d.home, 'state', 'dreams', 'learn.db'), d.securePath), source,
    model: learningModel(options, () => localOnlyShared(d.config()), create), config: d.config, now: d.clock,
    principal: owner => d.resolveCollaborationPerson?.(owner) ?? null, signal: d.signal,
    ...(d.inbox ? { inbox: d.inbox } : {}),
    mayReadTarget(target, person) {
      if (!d.agents.has(target.agentId)) return false;
      const rights = readRights(person, target.agentId);
      if (!rights.agentPrivate) return false;
      if (target.scope === 'installation') return person.role === 'owner';
      if (target.scope === 'project') {
        const p = project(target.projectId!);
        return !!p && p.archivedAt === null && p.owner === target.owner && p.agents.includes(target.agentId) && rights.workspace;
      }
      return true;
    },
    async card(f) {
      const workspace = d.agents.workspaceOf(f.target.agentId);
      if (!workspace || !f.memoryId) return null;
      const { principal } = callerToPrincipal({ channel: 'cli', accountId: 'learn-read', userId: f.target.owner }, f.target.agentId, workspace);
      principal.user = deriveUserPrincipal(f.target.owner);
      try { return await d.engine.memory.show(f.memoryId, principal, { origin: 'system', background: true }); } catch { return null; }
    },
    async readPort(target): Promise<LearnReadPort | null> {
      const p = target.projectId ? project(target.projectId) : null;
      if (!p?.repo || p.archivedAt !== null || p.owner !== target.owner || !options) return null;
      const request: ChatRequest = { role: 'engine', agentId: target.agentId, projectId: p.id,
        principal: deriveUserPrincipal(target.owner), sessionId: `learn-${randomUUID()}`, turnId: `learn-${randomUUID()}`,
        readOnlyWorktree: p.repo.repoPath, approver: { person: null, surface: 0 },
        summaries: [], memory: '', messages: [], signal: d.signal };
      const all = await toolsForTurn(request), reads = new ToolRegistry();
      for (const name of ['file.read', 'file.list']) { const tool = all.get(name); if (tool) reads.register(tool); }
      const dispatcher = new ToolDispatcher({ registry: reads, grants: options.grants, clock: { now: d.clock },
        approvals: { request: async () => ({ approved: false }) },
        ...(options.grantUse ? { grantUse: options.grantUse } : {}), ...(options.audit ? { audit: options.audit } : {}),
        ...(options.knownSecrets ? { knownSecrets: options.knownSecrets } : {}),
        policyContext: ctx => ({ ...options.policyContext?.(ctx, request), projectId: p.id }),
      });
      return { async call(name, args, signal) {
        await d.permissions.open();
        const result = await dispatcher.call({ id: randomUUID(), name, args: name === 'file.read'
          ? { path: args.path, length: args.maxBytes ?? 32768, encoding: 'utf8' }
          : { path: args.path, maxEntries: args.maxEntries ?? 100 } },
        { agentId: target.agentId, principal: request.principal!, sessionId: request.sessionId, turnId: request.turnId!, surface: 0, signal });
        if (result.isError || !result.value || typeof result.value !== 'object') return { ok: false };
        const value = result.value as { content?: string; truncated?: boolean };
        return { ok: true, ...(typeof value.content === 'string' ? { text: value.content } : {}), truncated: value.truncated === true };
      } };
    },
  });
}
