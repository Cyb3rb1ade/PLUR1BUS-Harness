// `session.*` over the core's RPC (M1b-2c). The owner of every session is derived here from the caller identity (never
// sent, never client-controlled); a session of another owner is E_NOT_FOUND, never E_DENIED (no existence oracle).
import type {
  CallerIdentity, SessionArchiveParams, SessionCreateParams, SessionEvent, SessionEventsParams, SessionGetParams, SessionListParams, SessionMessage,
  SessionRecord as WireSession, SessionResumeParams, SessionSubmitParams,
} from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "../agents.ts";
import { requireAgent } from "../memory-ops.ts";
import { userPrincipalHash, validIdentity } from "../principal.ts";
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import type { SessionStore } from "./store.ts";
import { NoProviderError, type TurnRunner } from "./turn-loop.ts";
import { SessionError, type EventRecord, type MessageRecord, type SessionRecord } from "./types.ts";

export interface SessionMethodDeps { store: SessionStore; runner: TurnRunner; agents: AgentRegistry; isStopping: () => boolean }

/** The session owner: the engine's own user-principal hash of the caller. An identity that would not give the engine a
 *  proved user (G8) owns nothing: sessions are principal-scoped, so every session.* call fails closed. */
export function ownerOf(c: CallerIdentity): string {
  if (c.channel !== "cli" || !validIdentity(c.accountId) || !validIdentity(c.userId)) {
    throw new RpcError("E_DENIED", "caller identity is not valid", { reason: "principal-invalid" });
  }
  return userPrincipalHash(c);
}

export function mapSessionError(e: unknown): never {
  if (e instanceof RpcError) throw e;
  if (e instanceof NoProviderError) throw new RpcError("E_NOT_AVAILABLE", "no chat provider is configured; configure one or use a core started with the test provider", { reason: "no-provider" });
  if (e instanceof SessionError) {
    const d = e.reason ? { reason: e.reason } : {};
    switch (e.code) {
      case "invalid": throw new RpcError("E_INVALID_PARAMS", e.message, d);
      case "not-found": throw new RpcError("E_NOT_FOUND", e.message, d);
      case "conflict": throw new RpcError("E_CONFLICT", e.message, d);
      case "immutable": throw new RpcError("E_DENIED", e.message, d);
      case "storage": throw new RpcError("E_STORAGE", e.message, d);
    }
  }
  throw e;
}

export const toWireSession = (s: SessionRecord): WireSession => ({
  id: s.id, kind: s.kind, agentId: s.agentId, scope: s.scope, chatKey: s.chatKey, title: s.title, pinned: s.pinned, memoryMode: s.memoryMode,
  createdAt: s.createdAt, updatedAt: s.updatedAt, lastTurnAt: s.lastTurnAt, archivedAt: s.archivedAt, turnCount: s.turnCount,
});
export const toWireEvent = (e: EventRecord): SessionEvent => ({ sessionId: e.sessionId, seq: e.seq, turnId: e.turnId, type: e.type, data: e.data, at: e.at });
const toWireMessage = (m: MessageRecord): SessionMessage => ({ id: m.id, seq: m.seq, turnId: m.turnId, role: m.role, text: m.text, createdAt: m.createdAt });

const stopping = (): RpcError => new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });

export function buildSessionMethods(d: SessionMethodDeps): Record<string, Handler> {
  const wrap = <P extends { caller: CallerIdentity }>(fn: (p: P, owner: string, signal: AbortSignal) => Promise<unknown> | unknown): Handler =>
    async (p: P, ctx) => { try { return await fn(p, ownerOf(p.caller), ctx.signal); } catch (e) { return mapSessionError(e); } };

  return {
    "session.create": wrap(async (p: SessionCreateParams, owner) => {
      requireAgent(d.agents, p.agentId);
      const kind = p.kind ?? "direct";
      const session = d.store.createSession({
        kind, agentId: p.agentId, owner,
        ...(p.title !== undefined ? { title: p.title } : {}), ...(p.memoryMode ? { memoryMode: p.memoryMode } : {}),
        ...(p.chatKey !== undefined ? { chatKey: p.chatKey } : {}), ...(p.replaceActive !== undefined ? { replaceActive: p.replaceActive } : {}),
      });
      return { session: toWireSession(session) };
    }),

    "session.list": wrap(async (p: SessionListParams, owner) => {
      const r = d.store.listSessions({
        owner, ...(p.kind ? { kind: p.kind } : {}), ...(p.agentId ? { agentId: p.agentId } : {}), ...(p.archived ? { archived: p.archived } : {}),
        ...(p.search !== undefined ? { search: p.search } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}),
      });
      return { sessions: r.sessions.map(toWireSession), truncated: r.truncated };
    }),

    "session.get": wrap(async (p: SessionGetParams, owner) => {
      const s = d.store.getOwned(p.sessionId, owner);
      return {
        session: toWireSession(s), runningTurnId: d.store.runningTurn(s.id)?.id ?? null,
        ...(p.messages ? { messages: d.store.listMessages(s.id).slice(-p.messages).map(toWireMessage) } : {}),
      };
    }),

    "session.resume": wrap(async (p: SessionResumeParams, owner) => {
      const s = d.store.getOwned(p.sessionId, owner);
      if (s.archivedAt !== null) throw new SessionError("conflict", `session ${s.id} is archived`, "archived");
      const limit = p.limit ?? 100;
      const all = d.store.listMessages(s.id);
      const lastEventSeq = lastSeq(d.store, s.id);
      return { session: toWireSession(s), runningTurnId: d.store.runningTurn(s.id)?.id ?? null, messages: all.slice(-limit).map(toWireMessage), lastEventSeq };
    }),

    "session.archive": wrap(async (p: SessionArchiveParams, owner) => {
      d.store.getOwned(p.sessionId, owner);
      return { session: toWireSession(d.store.archiveSession(p.sessionId)) };
    }),

    "session.submit": wrap(async (p: SessionSubmitParams, owner, signal) => {
      if (d.isStopping()) throw stopping();
      const s = d.store.getOwned(p.sessionId, owner);
      requireAgent(d.agents, s.agentId);
      const h = d.runner.submit({ session: s, caller: p.caller, text: p.text });
      if (p.wait !== true) return { sessionId: s.id, turnId: h.turnId, messageId: h.messageId, state: "running" as const };
      // The turn is the core's, not the connection's: a client that hangs up does not cancel it (it is replayable by session.events).
      const out = await Promise.race([h.done, new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(signal.reason), { once: true }))]);
      return { sessionId: s.id, turnId: h.turnId, messageId: h.messageId, state: out.state, ...(out.reply !== undefined ? { reply: out.reply } : {}), ...(out.error !== undefined ? { error: out.error } : {}) };
    }),

    "session.events": wrap(async (p: SessionEventsParams, owner) => {
      const s = d.store.getOwned(p.sessionId, owner);
      const events = d.store.listEvents(s.id, p.afterSeq ?? 0, p.limit ?? 500);
      return { sessionId: s.id, events: events.map(toWireEvent), lastSeq: lastSeq(d.store, s.id), running: d.store.runningTurn(s.id) !== null };
    }),
  };
}

/** The session's newest event seq: the cursor a client continues from. */
function lastSeq(store: SessionStore, sessionId: string): number {
  return store.lastEventSeq(sessionId) ?? 0;
}
