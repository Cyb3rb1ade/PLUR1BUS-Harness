/** D120 Q13/Q14: read existing D115 card/session links and the shared worktree port; never create a second binding. */
import type { Collab } from "../collab/service.ts";
import type { ProjectWorktreePort } from "../collab/coding-surface.ts";
import type { Principal } from "../rbac/types.ts";
import type { SessionRecord } from "./types.ts";

/** A unique active card must link this session and assign its stored agent; ambiguity refuses automatic/file rewind. */
export function rewindProjectContext(session: SessionRecord, person: Principal, collab: Collab, worktrees: ProjectWorktreePort): {
  projectId: string; cardId: string; root: string;
} | null {
  if (session.kind !== "card" || session.archivedAt !== null || person.kind !== "person") return null;
  let found: { projectId: string; cardId: string; root: string } | null = null;
  for (const project of collab.listProjects(person)) {
    if (project.archivedAt !== null || !project.agents.includes(session.agentId)) continue;
    let cursor: string | undefined;
    do {
      const page = collab.boardStore.cards(project.id, { archived: false, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const card of page.cards) {
        if (!card.links.some(link => link.kind === "session" && link.id === session.id)
          || !card.assignees.some(assignee => assignee.kind === "agent" && assignee.id === session.agentId)) continue;
        const root = worktrees.root(session.agentId, project.id, card.id);
        if (!root || found) return null;
        found = { projectId: project.id, cardId: card.id, root };
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  return found;
}
