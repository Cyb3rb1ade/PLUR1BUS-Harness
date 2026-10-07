// `session.list` for the overview: the caller's own direct sessions, archived ones included (the status filter is client side),
// at most 200 (the RPC maximum). The browser sends no `caller`; the Harness API derives it from the session (docs/web-ui.md F1).
import { getApi, useLoad } from "../../common/load.ts";
import type { SessionMeta } from "./model.ts";

export const LIMIT = 200;
export type SessionsAnswer = { sessions: SessionMeta[]; truncated: boolean };

/** Keeps exactly the metadata fields: whatever else a server might add (a preview, a message) never reaches the view. */
export function metaOf(r: SessionMeta): SessionMeta {
  return { id: r.id, kind: r.kind, agentId: r.agentId, title: typeof r.title === "string" ? r.title : "", pinned: r.pinned === true, createdAt: r.createdAt, updatedAt: r.updatedAt, lastTurnAt: r.lastTurnAt ?? null, archivedAt: r.archivedAt ?? null, turnCount: r.turnCount ?? 0 };
}

export function useSessions(enabled: boolean) {
  return useLoad<SessionsAnswer>(async (signal) => {
    if (!enabled) return { sessions: [], truncated: false };
    const r = (await getApi().rpc("session.list", { kind: "direct", archived: "any", limit: LIMIT }, { write: false, signal })) as unknown as SessionsAnswer;
    return { sessions: r.sessions.map(metaOf), truncated: r.truncated === true };
  }, [enabled]);
}
