// Direct-chat identity is always the authenticated harness person, never CallerIdentity supplied by a browser.
import type { AgentRegistry } from "../agents.ts";
import { requireAgent } from "../memory-ops.ts";
import { createHash, createHmac, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { authorize } from "../rbac/authorize.ts";
import type { Principal } from "../rbac/types.ts";
import type { AuditSink } from "../rbac/audit.ts";
import { deriveUserPrincipal } from "../identity/principals.ts";
import { mapSessionError, toWireEvent, toWireSession } from "../session/methods.ts";
import type { SessionService } from "../session/service.ts";
import { SessionError } from "../session/types.ts";
import type { Handler } from "./server.ts";
import { RpcError } from "./errors.ts";
import { REASONING_CHOICES, chatModelOptions, effectiveReasoning, isReasoningChoice, type ChatModelSources, type ReasoningChoice } from "../session/chat-models.ts";

function canonical(value:unknown):unknown { return Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])):value; }

export function buildChatSurface(d: { sessions: () => SessionService | null; agents: AgentRegistry; audit: AuditSink; now: () => number; approver: (ctx: Parameters<Handler>[1], params: unknown) => Promise<import("../session/provider.ts").TurnApprover>;
  /** The per-chat model choice (profiles, reasoning per model, "Nur lokal"); absent or null: chat.model.* answer E_NOT_AVAILABLE. */
  models?: () => ChatModelSources | null }): Record<string, Handler> {
  const writes = new Set(["create", "submit", "cancel", "update", "archive", "restore", "fork", "delete", "model.set"]);
  const sources = () => { const s = d.models?.(); if (!s) throw new RpcError("E_NOT_AVAILABLE", "no chat provider is configured", { reason: "no-provider" }); return s; };
  const storedChoice = (v: string | null): ReasoningChoice => (isReasoningChoice(v) ? v : "default");
  const idempotent = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  const cursorKey = randomBytes(32);
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
      const owner = deriveUserPrincipal(a.userId), limit = p.limit ?? 200;
      const binding = createHash("sha256").update(JSON.stringify({ owner, agentId:p.agentId ?? null, archived:p.archived ?? "exclude", search:p.search ?? null })).digest("base64url");
      let after: { pinned:boolean; updatedAt:number; id:string } | undefined;
      if (p.cursor !== undefined) {
        try {
          if (typeof p.cursor!=="string" || p.cursor.length>2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(p.cursor)) throw Error();
          const [payload,mac]=p.cursor.split("."),expected=createHmac("sha256",cursorKey).update(payload).digest();
          const given=Buffer.from(mac,"base64url");if(given.length!==expected.length||given.toString("base64url")!==mac||!timingSafeEqual(given,expected))throw Error();
          const decoded=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
          if(decoded.v!==1||decoded.binding!==binding||typeof decoded.after?.pinned!=="boolean"||!Number.isSafeInteger(decoded.after.updatedAt)||decoded.after.updatedAt<0||typeof decoded.after.id!=="string"||decoded.after.id.length>128)throw Error();
          after=decoded.after;
        } catch { throw new RpcError("E_INVALID_PARAMS","invalid or differently bound chat cursor"); }
      }
      const {tokenScopes:_scopes,...role}=a;
      const allowedAgents=d.agents.list().filter(agentId=>authorize(role,"agent.read",{kind:"agent",agentId}).effect==="allow");
      const pages=[runtime(),runtime().ephemeral()].map(service=>service.store.listChatSessions({owner,allowedAgents,...(p.agentId?{agentId:p.agentId}:{}),archived:p.archived??"exclude",...(p.search!==undefined?{search:p.search}:{}),limit:limit+1,...(after?{after}:{})}));
      const visible=pages.flatMap(page=>page.sessions).sort((x,y)=>Number(y.pinned)-Number(x.pinned)||y.updatedAt-x.updatedAt||(x.id<y.id?-1:x.id>y.id?1:0));
      const sessions=visible.slice(0,limit),truncated=visible.length>limit||pages.some(page=>page.truncated);
      const last=sessions.at(-1);let nextCursor:string|null=null;
      if(truncated&&last){const payload=Buffer.from(JSON.stringify({v:1,binding,after:{pinned:last.pinned,updatedAt:last.updatedAt,id:last.id}})).toString("base64url");nextCursor=`${payload}.${createHmac("sha256",cursorKey).update(payload).digest("base64url")}`;}
      return {sessions:sessions.map(toWireSession),truncated,nextCursor};
    },
    get(p,a) {
      const { service,session } = owned(p.sessionId,a,false);
      return { session: toWireSession(session), modelChanges: service.store.modelChanges(session.id).map(toWireEvent), messages: service.store.listMessages(session.id,{limit:p.limit ?? 200,...(p.beforeSeq!==undefined?{beforeSeq:p.beforeSeq}:{})}).map(({id,seq,turnId,role,text,createdAt})=>({id,seq,turnId,role,text,createdAt})), runningTurnId:service.store.runningTurn(session.id)?.id ?? null, lastEventSeq:service.store.lastEventSeq(session.id) ?? 0 };
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
    "model.get"(p,a) {
      // The chat's own model and reasoning choice and what it may pick: identity from the authenticated person only.
      const {service,session}=owned(p.sessionId,a,false), s=sources(), current=service.store.modelProfile(session.id);
      return { sessionId:session.id, profile:current.profile, defaultProfile:s.defaultProfile() ?? null, reasoning:storedChoice(service.store.modelReasoning(session.id)), revision:current.revision, profiles:chatModelOptions(s,session.agentId) };
    },
    "model.set"(p,a) {
      const {service,session}=owned(p.sessionId,a,true), s=sources();
      const options=chatModelOptions(s,session.agentId), option=options.find(o=>o.name===p.profile);
      if(!option)throw new RpcError("E_NOT_AVAILABLE","model profile is not configured",{reason:"model-profile-unavailable"});
      if(option.disabledReason==="local-only")throw new RpcError("E_DENIED","only local models may be used in this chat",{reason:"local-only"});
      if(option.disabledReason==="unavailable")throw new RpcError("E_NOT_AVAILABLE","the model is not available",{reason:"model-unavailable"});
      const before=service.store.modelProfile(session.id), previousReasoning=storedChoice(service.store.modelReasoning(session.id));
      // Absent keeps the chat's stored choice (a model switch alone does not reset the level).
      const reasoning:ReasoningChoice=p.reasoning ?? previousReasoning;
      if(!isReasoningChoice(reasoning))throw new RpcError("E_INVALID_PARAMS",`reasoning must be one of ${REASONING_CHOICES.join(", ")}`);
      const previousOption=options.find(o=>o.name===(before.profile ?? s.defaultProfile()));
      const now=effectiveReasoning(reasoning,option.reasoning);
      const revision=service.store.setModelProfile(session.id,p.profile,p.expectedRevision,reasoning==="default"?null:reasoning,a.userId,{model:option.model,displayName:option.displayName,effectiveReasoning:now.level ?? "default"});
      record("model.set",a,session.id);
      const was=previousOption?effectiveReasoning(previousReasoning,previousOption.reasoning).level:null;
      const order=["off","minimal","low","medium","high","xhigh"], changed=before.profile!==p.profile||previousReasoning!==reasoning;
      return { sessionId:session.id, profile:p.profile, previousProfile:before.profile, reasoning, effectiveReasoning:now.level ?? "default", adjusted:now.adjusted, revision,
        ...(changed?{warning:"cache-rebuild-cost-prefixes-preserved"}:{}),
        ...(now.level!==null&&order.indexOf(now.level)>=order.indexOf("high")&&(was===null||order.indexOf(now.level)>order.indexOf(was))?{costHint:"reasoning-cost-higher"}:{}) };
    },
    export(p,a) {const {service,session}=owned(p.sessionId,a,false);record("export",a,p.sessionId);return {session:toWireSession(session),messages:service.store.listMessages(p.sessionId).map(({id,seq,turnId,role,text,createdAt})=>({id,seq,turnId,role,text,createdAt}))};},
  };
  return Object.fromEntries(Object.entries(actions).map(([name,run])=>[`chat.${name}`,async(p,ctx)=>{
    try {
    const a=authenticatedPrincipal(ctx);
    const key=p.idempotencyKey?`${a.userId}:${name}:${p.idempotencyKey}`:undefined;
    const fingerprint=JSON.stringify(canonical({...p,idempotencyKey:undefined,resumeAfterSeq:undefined}));
    if (p.sessionId) owned(p.sessionId,a,writes.has(name));
    if (name === "create") { requireAgent(d.agents,p.agentId); rights(a,p.agentId,true); }
    if(p.resumeAfterSeq!==undefined && (name!=="submit"||!key||!idempotent.has(key)))throw new RpcError("E_CONFLICT","resume requires the original retained idempotency key");
    if(key && idempotent.has(key)){
      const previous=idempotent.get(key)!;if(previous.fingerprint!==fingerprint)throw new RpcError("E_CONFLICT","idempotency key changed");
      const result=await previous.result;
      if(p.resumeAfterSeq!==undefined){const {service}=owned(p.sessionId,a,false);const event=service.store.listEvents(p.sessionId,p.resumeAfterSeq-1,1)[0];if(!event||event.seq!==p.resumeAfterSeq||event.turnId!==(result as {turnId:string}).turnId)throw new RpcError("E_INVALID_PARAMS","resume event does not belong to the original turn");}
      return result;
    }
    if(key && idempotent.size>=2048)throw new RpcError("E_NOT_AVAILABLE","idempotency capacity reached");
    const result=Promise.resolve().then(()=>run(p,a,ctx)).catch(e=>{if(key)idempotent.delete(key);return mapSessionError(e);});
    if(key && writes.has(name))idempotent.set(key,{fingerprint,result});
    return result;
    } catch(e) { return mapSessionError(e); }
  }]));
}
