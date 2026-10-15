// Direct-chat identity is always the authenticated harness person, never CallerIdentity supplied by a browser.
import type { AgentRegistry } from "../agents.ts";
import { requireAgent } from "../memory-ops.ts";
import { randomUUID } from "node:crypto";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { authorize } from "../rbac/authorize.ts";
import type { Principal } from "../rbac/types.ts";
import type { AuditSink } from "../rbac/audit.ts";
import { deriveUserPrincipal } from "../identity/principals.ts";
import { mapSessionError, toWireEvent, toWireSession } from "../session/methods.ts";
import type { SessionService } from "../session/service.ts";
import { SessionError, type SessionRecord } from "../session/types.ts";
import type { Handler } from "./server.ts";
import { RpcError } from "./errors.ts";

export function buildChatSurface(d: { sessions: () => SessionService | null; agents: AgentRegistry; audit: AuditSink; now: () => number; approver: (ctx: Parameters<Handler>[1], params: unknown) => Promise<import("../session/provider.ts").TurnApprover> }): Record<string, Handler> {
  const writes = new Set(["create", "submit", "cancel", "update", "archive", "restore", "fork", "delete"]);
  const idempotent = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  const confirmations = new Map<string, { sessionId: string; person: string; expires: number }>();
  const runtime = () => { const s = d.sessions(); if (!s) throw new RpcError("E_NOT_AVAILABLE", "chat unavailable"); return s; };
  const rights = (a: Principal, agentId: string, write: boolean) => {
    // The chat scope already passed RPC_RULES; object rights and role must additionally permit this agent.
    const { tokenScopes: _scopes, ...role } = a;
    if (authorize(role, write ? "agent.use" : "agent.read", { kind: "agent", agentId }).effect !== "allow") throw new RpcError("E_DENIED", "agent right required");
  };
  const owned = (id: string, a: Principal, write: boolean) => {
    const service = runtime().forSession(id), session = service.store.getOwned(id, deriveUserPrincipal(a.userId));
    if (session.kind !== "direct") throw new RpcError("E_NOT_FOUND", "chat not found");
    rights(a, session.agentId, write); return { service, session };
  };
  const record = (action: string, a: Principal, target: string) => d.audit.append({ at: d.now(), actor: { user: a.userId, host: "core" }, action: `chat.${action}`, target, detail: {} });
  const actions: Record<string, (p: any, a: Principal, ctx: Parameters<Handler>[1]) => unknown | Promise<unknown>> = {
    create(p, a) {
      requireAgent(d.agents, p.agentId); rights(a, p.agentId, true);
      const service = p.memoryMode === "incognito" ? runtime().ephemeral() : runtime();
      record("create", a, p.agentId);
      return { session: toWireSession(service.store.createSession({ kind: "direct", agentId: p.agentId, owner: deriveUserPrincipal(a.userId), ...(p.title !== undefined ? { title: p.title } : {}), memoryMode: p.memoryMode ?? "remember" })) };
    },
    list(p, a) {
      const owners = [deriveUserPrincipal(a.userId)];
      const sessions: SessionRecord[] = [];
      for (const service of [runtime(), runtime().ephemeral()]) for (const owner of owners) sessions.push(...service.store.listSessions({ owner, kind: "direct", ...(p.agentId ? { agentId: p.agentId } : {}), archived: p.archived ?? "exclude", ...(p.search ? { search: p.search } : {}), limit: p.limit ?? 200 }).sessions);
      const { tokenScopes: _scopes, ...role } = a;
      const visible = sessions.filter(s => authorize(role, "agent.read", { kind: "agent", agentId: s.agentId }).effect === "allow").sort((x,y) => Number(y.pinned) - Number(x.pinned) || y.updatedAt - x.updatedAt || x.id.localeCompare(y.id));
      return { sessions: visible.slice(0,p.limit ?? 200).map(toWireSession), truncated: visible.length > (p.limit ?? 200) };
    },
    get(p,a) {
      const { service,session } = owned(p.sessionId,a,false);
      return { session: toWireSession(session), messages: service.store.listMessages(session.id,{limit:p.limit ?? 200}).map(({id,seq,turnId,role,text,createdAt})=>({id,seq,turnId,role,text,createdAt})), runningTurnId:service.store.runningTurn(session.id)?.id ?? null, lastEventSeq:service.store.lastEventSeq(session.id) ?? 0 };
    },
    update(p,a) { const {service}=owned(p.sessionId,a,true); if (service.store.runningTurn(p.sessionId)) throw new SessionError("conflict","turn running","turn-running"); record("update",a,p.sessionId); return {session:toWireSession(service.store.updateSession(p.sessionId,{...(p.title !== undefined ? {title:p.title}:{}),...(p.pinned !== undefined ? {pinned:p.pinned}:{})}))}; },
    archive(p,a) { const {service}=owned(p.sessionId,a,true); record("archive",a,p.sessionId);return {session:toWireSession(service.store.archiveSession(p.sessionId))}; },
    restore(p,a) { const {service}=owned(p.sessionId,a,true); record("restore",a,p.sessionId);return {session:toWireSession(service.store.restoreSession(p.sessionId))}; },
    fork(p,a) {
      const {service,session}=owned(p.sessionId,a,true); if(service.store.runningTurn(session.id))throw new SessionError("conflict","turn running","turn-running");
      record("fork",a,session.id);
      return {session:toWireSession(service.store.forkSession(session.id,{...(p.title !== undefined?{title:p.title}:{}),...(p.beforeSeq !== undefined?{beforeSeq:p.beforeSeq}:{})}))};
    },
    delete(p,a) {
      const {service,session}=owned(p.sessionId,a,true);
      if(session.archivedAt === null)throw new SessionError("conflict","archive first","not-archived");
      if (!p.nonce) {
        for(const [key,v] of confirmations)if(v.expires <= d.now())confirmations.delete(key);
        if(confirmations.size >= 1024)throw new RpcError("E_NOT_AVAILABLE","confirmation capacity reached");
        const nonce=randomUUID();confirmations.set(nonce,{sessionId:session.id,person:a.userId,expires:d.now()+60000});return {confirmation:{nonce,expiresAt:d.now()+60000}};
      }
      const proof=confirmations.get(p.nonce); confirmations.delete(p.nonce);
      if(!proof||proof.sessionId!==session.id||proof.person!==a.userId||proof.expires<=d.now())throw new RpcError("E_DENIED","confirmation invalid");
      record("delete",a,session.id);const result=service.store.eraseSession(session.id,{actor:a.userId,reason:"explicit direct-chat deletion"});return {purged:true,...result};
    },
    async submit(p,a,ctx) {
      const {service,session}=owned(p.sessionId,a,true);record("submit",a,session.id);
      const h=service.runner.submit({session,caller:{channel:"cli",accountId:"harness-api",userId:a.userId},authenticatedPerson:a.userId,text:p.text,approver:await d.approver(ctx,p)});
      if(!p.wait)return {sessionId:session.id,turnId:h.turnId,messageId:h.messageId,state:"running"};
      const result=await h.done;return {sessionId:session.id,turnId:h.turnId,messageId:h.messageId,state:result.state,...(result.reply!==undefined?{reply:result.reply}:{}),...(result.error!==undefined?{error:result.error}:{})};
    },
    cancel(p,a) {const {service}=owned(p.sessionId,a,true);record("cancel",a,p.sessionId);const turnId=service.runner.cancel(p.sessionId);return {sessionId:p.sessionId,turnId,cancelled:turnId !== null};},
    events(p,a) {const {service}=owned(p.sessionId,a,false);return {sessionId:p.sessionId,events:service.store.listEvents(p.sessionId,p.afterSeq ?? 0,p.limit ?? 500).map(toWireEvent),lastSeq:service.store.lastEventSeq(p.sessionId) ?? 0,running:service.store.runningTurn(p.sessionId)!==null};},
    export(p,a) {const {service,session}=owned(p.sessionId,a,false);record("export",a,p.sessionId);return {session:toWireSession(session),messages:service.store.listMessages(p.sessionId).map(({id,seq,turnId,role,text,createdAt})=>({id,seq,turnId,role,text,createdAt}))};},
  };
  return Object.fromEntries(Object.entries(actions).map(([name,run])=>[`chat.${name}`,async(p,ctx)=>{
    try {
    const a=authenticatedPrincipal(ctx);
    const key=p.idempotencyKey?`${a.userId}:${name}:${p.idempotencyKey}`:undefined;
    const fingerprint=JSON.stringify({...p,idempotencyKey:undefined});
    if (p.sessionId) owned(p.sessionId,a,writes.has(name));
    if (name === "create") { requireAgent(d.agents,p.agentId); rights(a,p.agentId,true); }
    if(key && idempotent.has(key)){const previous=idempotent.get(key)!;if(previous.fingerprint!==fingerprint)throw new RpcError("E_CONFLICT","idempotency key changed");return previous.result;}
    if(key && idempotent.size>=2048)throw new RpcError("E_NOT_AVAILABLE","idempotency capacity reached");
    const result=Promise.resolve().then(()=>run(p,a,ctx)).catch(e=>{if(key)idempotent.delete(key);return mapSessionError(e);});
    if(key && writes.has(name))idempotent.set(key,{fingerprint,result});
    return result;
    } catch(e) { return mapSessionError(e); }
  }]));
}
