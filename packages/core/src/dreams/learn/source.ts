import type { IdentityService } from "../../identity/service.ts";
import type { ChannelOrigin } from "../../channels/behaviour-context.ts";
import type { HarnessConfig } from '@plur1bus/config-schema';
import type { SessionStore } from '../../session/store.ts';
import type { Project } from '../../collab/types.ts';
import { deriveUserPrincipal } from '../../identity/principals.ts';
import { readRights, resolveExposure } from '../../memory-exposure/index.ts';
import { LIMITS, type Evidence, type SelectionSource } from './types.ts';

/** All scope inputs come from the configured target and live registries, never model output. */
export function learningSource(store: SessionStore, o: { config(): HarnessConfig; hasAgent(id: string): boolean; project(id: string): Project | null; identity?(): Pick<IdentityService, 'resolve' | 'getLink'> | null }): SelectionSource {
  const source: SelectionSource = {
    toolErrors: (t, w) => store.learningToolErrors(deriveUserPrincipal(t.owner), w),
    session: id => store.getSession(id),
    sessions: (t, w, limit, offset = 0) => store.learningSessions({ owner: deriveUserPrincipal(t.owner), ...(t.scope === 'agent' ? { agentId: t.agentId } : {}), ...(t.projectId ? { projectId: t.projectId } : {}), ...w, limit, offset }),
    mayRead(target, session, principal) {
      if (session.owner !== deriveUserPrincipal(target.owner) || session.memoryMode !== 'remember' || (target.projectId && session.scope !== target.projectId)) return false;
      if (!o.hasAgent(session.agentId) || !o.hasAgent(target.agentId) || principal.userId !== target.owner) return false;
      const source = readRights(principal, session.agentId), destination = readRights(principal, target.agentId);
      if (!source.agentPrivate || !(target.scope === 'project' ? destination.workspace : destination.agentPrivate)) return false;
      if (target.projectId) {
        const project = o.project(target.projectId);
        if (!project || project.archivedAt !== null || project.owner !== target.owner || !project.agents.includes(session.agentId) || !project.agents.includes(target.agentId)) return false;
      } else if (target.scope !== 'installation' && session.agentId !== target.agentId) return false;
      // External and project exposure can only narrow the already granted rights.
      const channel = session.origin === 'mcp' ? 'mcp' : session.origin === 'a2a' ? 'a2a' : 'collab';
      const exposure = resolveExposure({ channel, agentId: session.agentId, principal, config: o.config() });
      return target.scope === 'project' ? exposure.recall.workspace && exposure.recall.agentPrivate : exposure.recall.agentPrivate;
    },
    transcript(session, window) { return read(session, window); },
    evidence(session, refs) { return read(session, { from: 0, to: Number.MAX_SAFE_INTEGER }, refs); },
  };
  function read(session: Parameters<SelectionSource['transcript']>[0], window: Parameters<SelectionSource['transcript']>[1], refs?: readonly Evidence[]) {
      const { messages, events } = store.learningTranscript(session.id, window, LIMITS, refs ? [...new Set(refs.map(e => e.turnId))] : undefined);
      const personMessageIds = messages.filter(message => {
        if (session.kind !== 'channel' || message.role !== 'user') return false;
        const event = events.find(e => e.type === 'turn.started' && e.turnId === message.turnId);
        const origin = event?.data.channelOrigin as ChannelOrigin | undefined;
        if (!origin || origin.chatKind !== 'direct' || !origin.accountId || !origin.senderId || !origin.humanId ||
          session.chatKey !== `${origin.channel}:${origin.chatId}` || session.owner !== deriveUserPrincipal(origin.humanId)) return false;
        const identity = o.identity?.();
        if (!identity) return false;
        try {
          const hit = identity.resolve({ channel: origin.channel, accountId: origin.accountId, userId: origin.senderId });
          if (!hit || hit.humanId !== origin.humanId) return false;
          const link = identity.getLink(hit.linkId);
          return link.revokedAt === null && link.linkedAt <= event!.at;
        } catch { return false; }
      }).map(m => m.id);
      return { session, messages, events, personMessageIds, days: [...new Set(messages.map(m => new Date(m.createdAt).toISOString().slice(0, 10)))].sort() };
  }
  return source;
}
