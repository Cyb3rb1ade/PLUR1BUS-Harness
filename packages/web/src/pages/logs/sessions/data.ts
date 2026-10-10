// `session.list` for the overview: direct sessions with metadata (owner, model, usage).
// For operators/admins, requests allOwners: true to view sessions of other users.
import { getApi, useLoad } from "../../common/load.ts";
import type { SessionMeta } from "./model.ts";
import "../../common/admin-rpc.ts";

export const LIMIT = 200;
export type SessionsAnswer = { sessions: SessionMeta[]; truncated: boolean };

/** Keeps metadata fields including owner, model and token accounting. */
export function metaOf(r: SessionMeta): SessionMeta {
  return {
    id: r.id,
    kind: r.kind,
    agentId: r.agentId,
    title: typeof r.title === "string" ? r.title : "",
    pinned: r.pinned === true,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastTurnAt: r.lastTurnAt ?? null,
    archivedAt: r.archivedAt ?? null,
    turnCount: r.turnCount ?? 0,
    ...(typeof r.owner === "string" ? { owner: r.owner } : {}),
    model: typeof r.model === "string" ? r.model : null,
    ...(r.usage ? { usage: {
      inputTokens: r.usage.inputTokens ?? 0,
      outputTokens: r.usage.outputTokens ?? 0,
      costMicros: r.usage.costMicros ?? null,
      ...(r.usage.pendingCalls !== undefined ? { pendingCalls: r.usage.pendingCalls } : {}),
    } } : {}),
  };
}

export function useSessions(enabled: boolean, isOperator = false) {
  return useLoad<SessionsAnswer>(async (signal) => {
    if (!enabled) return { sessions: [], truncated: false };
    const params = { kind: "direct" as const, archived: "any" as const, limit: LIMIT, ...(isOperator ? { allOwners: true } : {}) };
    const r = (await getApi().rpc("session.list", params, { write: false, signal })) as unknown as SessionsAnswer;
    return { sessions: (r.sessions ?? []).map(metaOf), truncated: r.truncated === true };
  }, [enabled, isOperator]);
}
