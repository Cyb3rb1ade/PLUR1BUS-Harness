// Transcript access is deliberately separate from metadata overview. A live library grant is checked and audited per read.
import type { SessionStore } from "../session/store.ts";
import type { BreakGlass } from "../rbac/break-glass.ts";
import type { Principal } from "../rbac/types.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Handler } from "./server.ts";
import { RpcError } from "./errors.ts";
import { toWireEvent, toWireSession, mapSessionError } from "../session/methods.ts";
import { hiddenToolOutputs } from "../session/pruning.ts";
export function sessionTranscriptSurface(d: { sessions: () => SessionStore | null; breakglass: BreakGlass; ownership: (a: Principal, p: unknown) => string[]; personOf: (owner: string) => string | undefined }): Record<string, Handler> {
  const read = (method: "get" | "resume" | "events"): Handler => async (p, ctx) => {
    const a = authenticatedPrincipal(ctx); if (a.kind !== "person") throw new RpcError("E_DENIED", "transcript reads require a person");
    const store = d.sessions(); if (!store) throw new RpcError("E_NOT_AVAILABLE", "sessions unavailable");
    const session = store.getSession(p?.sessionId); if (!session) throw new RpcError("E_NOT_FOUND", "session not found");
    if (!d.ownership(a, p).includes(session.owner)) {
      const person = d.personOf(session.owner);
      if (!person || d.breakglass.authorize(a, "memory.user.read", { kind: "memory", scope: "user", ownerUserId: person }).effect !== "allow") throw new RpcError("E_NOT_FOUND", "session not found");
    }
    try {
      const wire = toWireSession(session);
      const messages = (limit: number) => store.listMessages(session.id).slice(-limit).map(m => ({ id: m.id, seq: m.seq, turnId: m.turnId, role: m.role, text: m.text, createdAt: m.createdAt }));
      const runningTurnId = store.runningTurn(session.id)?.id ?? null;
      // includeHidden is opt-in and rides the same gate as the rest of the transcript: nothing above is relaxed for it.
      if (method === "get") return { session: wire, runningTurnId, ...(p.messages ? { messages: messages(p.messages) } : {}), ...(p.includeHidden === true ? { hiddenToolOutputs: hiddenToolOutputs(store, session.id) } : {}) };
      if (method === "resume") {
        if (session.archivedAt !== null) throw new RpcError("E_CONFLICT", "session is archived", { reason: "archived" });
        return { session: wire, runningTurnId, messages: messages(p.limit ?? 100), lastEventSeq: store.lastEventSeq(session.id) ?? 0 };
      }
      return { sessionId: session.id, events: store.listEvents(session.id, p.afterSeq ?? 0, p.limit ?? 500).map(toWireEvent), lastSeq: store.lastEventSeq(session.id) ?? 0, running: runningTurnId !== null };
    } catch (e) { return mapSessionError(e); }
  };
  return { "session.get": read("get"), "session.resume": read("resume"), "session.events": read("events") };
}
