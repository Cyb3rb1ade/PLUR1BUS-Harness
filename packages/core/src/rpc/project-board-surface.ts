import { authorize } from "../rbac/authorize.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import type { Collab } from "../collab/service.ts";
import { BoardError, type BoardActor } from "../collab/board.ts";
import type { Handler, NotifyOptions } from "./server.ts";
import { RpcError } from "./errors.ts";

export interface BoardChange { method: "project.card.changed" | "project.column.changed"; params: { projectId: string; cardId?: string; columnId?: string; change: string } }
export const BOARD_READ_METHODS = ["project.column.list", "project.card.list", "project.card.get", "project.card.comment.list", "project.card.activity.list"] as const;
export const BOARD_COLUMN_WRITES = ["project.column.create", "project.column.update", "project.column.move", "project.column.delete"] as const;
export const BOARD_CARD_WRITES = ["project.card.create", "project.card.update", "project.card.assign", "project.card.unassign", "project.card.archive", "project.card.unarchive"] as const;

/** Restores only live persisted rights. An agent's trusted userId is its agent identity, never a param. */
function admission(s: Collab, a: Principal, projectId: string, action: "read" | "write" | "manage" | "move" | "comment"): void {
  const p = s.boardProject(projectId);
  if (!p) throw new RpcError("E_NOT_FOUND", "project not found");
  if (a.kind !== "person" && a.kind !== "agent") throw new RpcError("E_DENIED", "explicit principal kind required");
  const rights = p.members.find(m => m.userId === a.userId)?.role;
  const stored = { ...a, projectRights: rights ? { [projectId]: rights } : {} };
  if (authorize(stored, `project.board.${action}`, { kind: "system" }).effect !== "allow") throw new RpcError("E_DENIED", "board access not permitted");
  if (a.kind === "agent") {
    if (!p.agents.includes(a.userId) || !["read", "move", "comment"].includes(action)) throw new RpcError("E_DENIED", "agent board access not permitted");
    return;
  }
  const objectAction = action === "manage" ? "project.manage" : action === "read" ? "project.read" : "project.write";
  const { tokenScopes: _scopes, ...objectPrincipal } = stored;
  if (authorize(objectPrincipal, objectAction, { kind: "project", projectId }).effect !== "allow" || (!rights && a.role !== "owner" && a.role !== "admin")) throw new RpcError("E_DENIED", "stored project membership required");
}
function failure(e: unknown): never {
  if (e instanceof RpcError) throw e;
  if (e instanceof BoardError) {
    const code = { invalid: "E_INVALID_PARAMS", "not-found": "E_NOT_FOUND", conflict: "E_CONFLICT", wip: "E_PROJECT_WIP_LIMIT", archived: "E_CONFLICT", denied: "E_DENIED" } as const;
    throw new RpcError(code[e.code], e.message, { reason: `project-board-${e.code}` });
  }
  throw new RpcError("E_STORAGE", "project board storage unavailable");
}

export function buildProjectBoardSurface(service: () => Collab | null, changed: (event: BoardChange) => void = () => {}): Record<string, Handler> {
  const bind = (method: string, action: "read" | "write" | "manage" | "move" | "comment", fn: (s: Collab, p: any, actor: BoardActor, override: boolean) => unknown): Handler => async (p, ctx) => {
    const a = authenticatedPrincipal(ctx), s = service();
    if (!s) throw new RpcError("E_NOT_AVAILABLE", "project board unavailable");
    try {
      admission(s, a, p.projectId, action);
      const override = p.overrideWip === true;
      if (override) admission(s, a, p.projectId, "manage");
      if (a.kind === "agent" && action === "move" && !s.boardStore.getCard(p.projectId, p.cardId).assignees.some(x => x.kind === "agent" && x.id === a.userId)) throw new RpcError("E_DENIED", "agent may move only assigned cards");
      const result = fn(s, p, { kind: a.kind!, id: a.userId }, override);
      if (action !== "read") {
        const column = method.startsWith("project.column.");
        const id = (result as { id?: string }).id;
        const event: BoardChange = { method: column ? "project.column.changed" : "project.card.changed", params: { projectId: p.projectId, ...(column ? { columnId: p.columnId ?? id } : { cardId: p.cardId ?? id }), change: method.split(".").at(-1)! } };
        // Delivery happens after COMMIT. A live delivery failure never changes the durable outcome.
        try { changed(event); } catch { /* clients can refresh */ }
        if (method === "project.column.delete" && p.targetColumnId) { try { changed({ method: "project.card.changed", params: { projectId: p.projectId, change: "column-deleted" } }); } catch { /* refresh */ } }
      }
      return result;
    } catch (e) { return failure(e); }
  };
  return {
    "project.column.list": bind("project.column.list", "read", (s, p) => ({ columns: s.boardStore.columns(p.projectId) })),
    "project.column.create": bind("project.column.create", "manage", (s, p) => s.boardStore.createColumn(p.projectId, p)),
    "project.column.update": bind("project.column.update", "manage", (s, p) => s.boardStore.updateColumn(p.projectId, p.columnId, p)),
    "project.column.move": bind("project.column.move", "manage", (s, p) => s.boardStore.moveColumn(p.projectId, p.columnId, p.position)),
    "project.column.delete": bind("project.column.delete", "manage", (s, p, a, o) => s.boardStore.deleteColumn(p.projectId, p.columnId, p.targetColumnId, a, o)),
    "project.card.list": bind("project.card.list", "read", (s, p) => s.boardStore.cards(p.projectId, p)),
    "project.card.get": bind("project.card.get", "read", (s, p) => s.boardStore.getCard(p.projectId, p.cardId)),
    "project.card.create": bind("project.card.create", "write", (s, p, a, o) => s.boardStore.createCard(p.projectId, p, a, o)),
    "project.card.update": bind("project.card.update", "write", (s, p, a) => s.boardStore.updateCard(p.projectId, p.cardId, p, a)),
    "project.card.move": bind("project.card.move", "move", (s, p, a, o) => s.boardStore.moveCard(p.projectId, p.cardId, p.columnId, p.position, a, o)),
    "project.card.assign": bind("project.card.assign", "write", (s, p, a) => s.boardStore.assign(p.projectId, p.cardId, p.assignee, true, a)),
    "project.card.unassign": bind("project.card.unassign", "write", (s, p, a) => s.boardStore.assign(p.projectId, p.cardId, p.assignee, false, a)),
    "project.card.archive": bind("project.card.archive", "write", (s, p, a) => s.boardStore.archiveCard(p.projectId, p.cardId, true, a)),
    "project.card.unarchive": bind("project.card.unarchive", "write", (s, p, a, o) => s.boardStore.archiveCard(p.projectId, p.cardId, false, a, o)),
    "project.card.comment.add": bind("project.card.comment.add", "comment", (s, p, a) => s.boardStore.comment(p.projectId, p.cardId, p.text, a)),
    "project.card.comment.list": bind("project.card.comment.list", "read", (s, p) => s.boardStore.comments(p.projectId, p.cardId, p)),
    "project.card.activity.list": bind("project.card.activity.list", "read", (s, p) => s.boardStore.activity(p.projectId, p.cardId, p)),
  };
}

/** /events audience is reauthorized with current membership and token scopes; no global broadcast of project ids. */
export async function deliverBoardChange(event: BoardChange, service: () => Collab | null, delivery: {
  subscriptions: () => readonly { connectionId: string }[];
  resolve: (id: string) => Promise<Principal | null | undefined>;
  notify: (method: string, params: object, options: NotifyOptions) => void;
}): Promise<void> {
  const audience: string[] = [];
  for (const id of new Set(delivery.subscriptions().map(s => s.connectionId))) {
    try { const a = await delivery.resolve(id), s = service(); if (!a || !s) continue; admission(s, a, event.params.projectId, "read"); audience.push(id); } catch { /* fail closed */ }
  }
  if (audience.length) delivery.notify(event.method, event.params, { audience });
}
