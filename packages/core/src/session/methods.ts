// `session.*` over the core's RPC (M1b-2c). The owner of every session is derived here from the caller identity (never
// sent, never client-controlled); a session of another owner is E_NOT_FOUND, never E_DENIED (no existence oracle).
import type {
  CallerIdentity, SessionArchiveParams, SessionCancelParams, SessionCreateParams, SessionEvent, SessionEventsParams, SessionGetParams, SessionListParams, SessionMessage,
  SessionRecord as WireSession, SessionResumeParams, SessionSubmitParams,
} from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "../agents.ts";
import { requireAgent } from "../memory-ops.ts";
import { userPrincipalHash, validIdentity } from "../principal.ts";
import { RpcError } from "../rpc/errors.ts";
import type { CallContext } from "@plur1bus/module-api";
import type { Handler } from "../rpc/server.ts";
import type { SessionStore } from "./store.ts";
import { NoProviderError, type TurnRunner } from "./turn-loop.ts";
import { isReasoningChoice, type ReasoningChoice } from "./chat-models.ts";
import { SessionError, type EventRecord, type MessageRecord, type SessionRecord } from "./types.ts";

/** The store, runner and compactor that serve one session: the durable ones, or the memory-only set of an incognito session. */
export interface SessionRuntime { store: SessionStore; runner: TurnRunner; compactor?: import("./compaction.ts").Compactor }
export interface SessionMethodDeps { /** The runtime holding the given session (the in-memory incognito one for ephemeral sessions, the durable one otherwise). Falls back to `store`/`runner`/`storeFor`. */ runtimeFor?: (sessionId: string) => SessionRuntime; /** The memory-only runtime where an incognito session is created, so nothing of it reaches disk. Absent: everything is durable. */ ephemeral?: () => SessionRuntime; modelProfiles?: () => readonly string[]; defaultProfile?: (agentId: string) => string | undefined; /** Store that holds the given session: the in-memory incognito store for ephemeral sessions, the durable store otherwise. */ storeFor?: (sessionId: string) => SessionStore;  compactor?: import("./compaction.ts").Compactor; store: SessionStore; runner: TurnRunner; agents: AgentRegistry; isStopping: () => boolean; /** Resolves the submitting connection's approver; never refuses (a non-person is refused only when a tool needs approval). */
  approver?: (ctx: CallContext, params: unknown) => Promise<import("./provider.ts").TurnApprover> }

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
  const wrap = <P extends { caller: CallerIdentity }>(fn: (p: P, owner: string, signal: AbortSignal, ctx: CallContext) => Promise<unknown> | unknown): Handler =>
    async (p: P, ctx) => { try { return await fn(p, ownerOf(p.caller), ctx.signal, ctx); } catch (e) { return mapSessionError(e); } };

  const rt = (sessionId: string): SessionRuntime => d.runtimeFor?.(sessionId) ?? { store: d.storeFor?.(sessionId) ?? d.store, runner: d.runner, ...(d.compactor ? { compactor: d.compactor } : {}) };

  return {
    "session.model.get": wrap(async (p: {caller: CallerIdentity; sessionId: string}, owner) => {
      const {store}=rt(p.sessionId), session=store.getOwned(p.sessionId,owner);
      requireAgent(d.agents,session.agentId);
      const current=store.modelProfile(session.id), stored=store.modelReasoning(session.id);
      return {sessionId:session.id,...current,defaultProfile:d.defaultProfile?.(session.agentId) ?? null,reasoning:isReasoningChoice(stored)?stored:"default"};
    }),
    "session.model.set": wrap(async (p: { caller: CallerIdentity; sessionId: string; profile: string; confirmed?: boolean; expectedRevision?: number; reasoning?: ReasoningChoice }, owner) => {
      if (d.isStopping()) throw stopping();
      // Incognito sessions live in a memory-only store; the profile is kept there too, so nothing reaches disk.
      const store = d.storeFor?.(p.sessionId) ?? d.store;
      const s = store.getOwned(p.sessionId, owner);
      requireAgent(d.agents, s.agentId);
      if (s.kind !== "direct" || s.archivedAt !== null || store.runningTurn(s.id)) throw new SessionError("conflict", "model switch requires an idle direct session", "session-busy");
      const current = store.modelProfile(s.id);
      const profile = p.profile;
      if (!d.modelProfiles?.().includes(profile)) throw new RpcError("E_NOT_AVAILABLE", "model profile is not configured", { reason: "model-profile-unavailable" });
      let revision = current.revision;
      if (p.confirmed === true) {
        if (p.expectedRevision === undefined) throw new RpcError("E_INVALID_PARAMS", "model switch confirmation requires the preview revision");
        revision = store.setModelProfile(s.id, profile, p.expectedRevision, p.reasoning === undefined ? undefined : p.reasoning === "default" ? null : p.reasoning);
      }
      // The reasoning choice that applies (or would apply) with this profile: the requested one, else the stored one.
      const stored = store.modelReasoning(s.id), reasoning: ReasoningChoice = p.reasoning ?? (isReasoningChoice(stored) ? stored : "default");
      return { sessionId: s.id, profile, previousProfile: current.profile, revision, applied: p.confirmed === true, warning: "cache-rebuild-cost-prefixes-preserved", reasoning };
    }),
    "session.create": wrap(async (p: SessionCreateParams, owner) => {
      requireAgent(d.agents, p.agentId);
      const kind = p.kind ?? "direct";
      // A chat key is `<channel>:<chatId>`. A caller only ever speaks for its own channel (ownerOf pins it), so it cannot bind a session to
      // another channel's chat: otherwise a member could pre-claim a group's key before it has a session and the switchboard would then run
      // the group's turns in the member's session (replaceActive cannot help there, there is nothing to replace). The switchboard itself
      // creates its sessions on the store, not through this method.
      if (p.chatKey !== undefined && (!p.chatKey.startsWith(`${p.caller.channel}:`) || p.chatKey.length === p.caller.channel.length + 1)) throw new SessionError("invalid", "chatKey must name the caller's own channel", "chat-key");
      // D92 §3.3: an incognito session lives in the memory-only store, exactly like chat.create's; its transcript never reaches the durable file.
      const target = p.memoryMode === "incognito" ? d.ephemeral?.().store ?? d.store : d.store;
      const session = target.createSession({
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
      const { store, compactor } = rt(p.sessionId);
      const s = store.getOwned(p.sessionId, owner);
      return {
        session: toWireSession(s), runningTurnId: store.runningTurn(s.id)?.id ?? null,
        ...(compactor ? { compaction: { hidden: compactor.view(s.id).hidden, summaries: store.listSummaries(s.id, "applied").map(s => ({ id: s.id, fromSeq: s.fromSeq, toSeq: s.toSeq })) } } : {}),
        ...(p.messages ? { messages: store.listMessages(s.id).slice(-p.messages).map(toWireMessage) } : {}),
      };
    }),

    "session.resume": wrap(async (p: SessionResumeParams, owner) => {
      const { store } = rt(p.sessionId);
      const s = store.getOwned(p.sessionId, owner);
      if (s.archivedAt !== null) throw new SessionError("conflict", `session ${s.id} is archived`, "archived");
      const limit = p.limit ?? 100;
      const all = store.listMessages(s.id);
      const lastEventSeq = lastSeq(store, s.id);
      return { session: toWireSession(s), runningTurnId: store.runningTurn(s.id)?.id ?? null, messages: all.slice(-limit).map(toWireMessage), modelChanges: store.modelChanges(s.id).map(toWireEvent), lastEventSeq };
    }),

    "session.archive": wrap(async (p: SessionArchiveParams, owner) => {
      const { store } = rt(p.sessionId);
      store.getOwned(p.sessionId, owner);
      return { session: toWireSession(store.archiveSession(p.sessionId)) };
    }),

    "session.submit": wrap(async (p: SessionSubmitParams, owner, signal, ctx) => {
      if (d.isStopping()) throw stopping();
      const { store, runner } = rt(p.sessionId);
      const s = store.getOwned(p.sessionId, owner);
      requireAgent(d.agents, s.agentId);
      const h = runner.submit({ session: s, caller: p.caller, text: p.text, ...(d.approver ? { approver: await d.approver(ctx, p) } : {}) });
      if (p.wait !== true) return { sessionId: s.id, turnId: h.turnId, messageId: h.messageId, state: "running" as const };
      // The turn is the core's, not the connection's: a client that hangs up does not cancel it (it is replayable by session.events).
      const out = await Promise.race([h.done, new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(signal.reason), { once: true }))]);
      return { sessionId: s.id, turnId: h.turnId, messageId: h.messageId, state: out.state, ...(out.reply !== undefined ? { reply: out.reply } : {}), ...(out.error !== undefined ? { error: out.error } : {}) };
    }),

    "session.cancel": wrap(async (p: SessionCancelParams, owner) => {
      const { store, runner } = rt(p.sessionId);
      const s = store.getOwned(p.sessionId, owner);
      const turnId = runner.cancel(s.id);
      return { sessionId: s.id, turnId, cancelled: turnId !== null };
    }),

    "session.events": wrap(async (p: SessionEventsParams, owner) => {
      const { store } = rt(p.sessionId);
      const s = store.getOwned(p.sessionId, owner);
      const events = store.listEvents(s.id, p.afterSeq ?? 0, p.limit ?? 500);
      return { sessionId: s.id, events: events.map(toWireEvent), lastSeq: lastSeq(store, s.id), running: store.runningTurn(s.id) !== null };
    }),
  };
}

/** The session's newest event seq: the cursor a client continues from. */
function lastSeq(store: SessionStore, sessionId: string): number {
  return store.lastEventSeq(sessionId) ?? 0;
}
