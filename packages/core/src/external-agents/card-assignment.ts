import type { CollabStore } from '../collab/store.ts';
import { BoardError } from '../collab/board.ts';

/** A selected card ID is never authority; consult the current project and board every time. */
export function cardAssignedTo(store: CollabStore, projectId: string, cardId: string, agentId: string, fromAgentId?: string): boolean {
  if (!cardId || !agentId) return false;
  const project = store.getProject(projectId);
  if (!project || project.archivedAt !== null) return false;
  const agents = fromAgentId === undefined ? [agentId] : [agentId, fromAgentId];
  if (agents.some(id => !id || !project.agents.includes(id))) return false;
  try {
    const card = store.board.getCard(projectId, cardId);
    return !card.archived && agents.every(id => card.assignees.some(a => a.kind === 'agent' && a.id === id));
  } catch (error) {
    if (error instanceof BoardError && error.code === 'not-found') return false;
    throw error;
  }
}
