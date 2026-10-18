import { createHash, randomBytes } from "node:crypto";
import type { CorePerson } from "./account-store.ts";
import type { Handler, HandlerDeps } from "./routes.ts";
import { API_VERSION, sessionCookie } from "./routes.ts";
import { ApiError, errors, fromCoreError } from "./errors.ts";
import type { Session } from "./session.ts";

export interface DesktopIdentity { deviceId:string; userId:string; scopes:string[]; expiresAt:number }
export function buildDesktopAttachHandlers(d: HandlerDeps, allowedOrigin:(origin:string)=>boolean) {
  const tickets = new Map<string,{identity:DesktopIdentity;origin:string;expiresAt:number}>();
  const hash = (v:string) => createHash("sha256").update(v).digest("hex");
  const service = async <T>(method:string,p:object):Promise<T> => {
    if(!d.core.serviceCall) throw new ApiError(503,"E_NOT_AVAILABLE","desktop service unavailable");
    try { return await d.core.serviceCall<T>(method,p); } catch(e) { throw fromCoreError(e); }
  };
  const person = async (identity:DesktopIdentity) => {
    const {person} = await service<{person:CorePerson|null}>("admin.api.person.resolve",{userId:identity.userId});
    if(!person || person.disabled) throw errors.unauthenticated("device-person");
    if(d.requireSecondFactor?.(person.role)) throw errors.forbidden("second-factor-required");
    return person;
  };
  const body = (v:unknown,fields:string[]) => {
    if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==fields.length||Object.keys(v).some(k=>!fields.includes(k)))throw errors.badRequest("body","closed desktop request required");
    const b=v as Record<string,string>;if(fields.some(k=>typeof b[k]!=="string"||!b[k]||b[k]!.length>4096))throw errors.badRequest("body","invalid desktop fields");return b;
  };
  const handlers: Record<string,Handler> = {
    "desktop.meta":async()=>({body:{version:API_VERSION,capabilities:["desktop-pair-v1","desktop-ticket-v1"],pairingRequired:true}}),
    "desktop.pair":async i=>{
      const b=body(i.body,["code","kind","name","publicKey"]);
      const result=await service("admin.api.desktop.redeem",b);
      return {body:{schema:"desktop.pair/1",...result as object}};
    },
    "desktop.redeem":async i=>{
      const b=body(i.body,["token","origin"]);
      if(!allowedOrigin(b.origin!) || i.origin!==undefined && i.origin!==b.origin)throw errors.forbidden("desktop-origin");
      const identity=await service<DesktopIdentity>("admin.api.desktop.token",{token:b.token}); await person(identity);
      for(const [key,t] of tickets)if(t.expiresAt<=d.clock.now())tickets.delete(key);
      if(tickets.size>=1024)throw errors.rateLimited(30);
      const ticket=randomBytes(32).toString("base64url"),expiresAt=Math.min(identity.expiresAt,d.clock.now()+30_000);
      tickets.set(hash(ticket),{identity,origin:b.origin!,expiresAt});
      return {body:{schema:"desktop.redeem/1",ticket,deviceId:identity.deviceId,expiresAt}};
    },
    "desktop.ticket":async i=>{
      const b=body(i.body,["ticket","deviceId"]),key=hash(b.ticket!),t=tickets.get(key);tickets.delete(key);
      if(!t || t.expiresAt<=d.clock.now() || t.origin!==i.origin || t.identity.deviceId!==b.deviceId)throw errors.unauthenticated("desktop-ticket");
      const identity=await service<DesktopIdentity>("admin.api.desktop.resolve",{deviceId:t.identity.deviceId});
      const p=await person(identity);
      if(identity.userId!==t.identity.userId)throw errors.unauthenticated("device-person");
      d.sessions.destroy(i.presentedSessionId);
      const principal={kind:"user" as const,id:identity.userId,role:p.role};
      const created=d.sessions.create(principal,{authVersion:p.version,device:identity});
      created.session.absoluteExpiresAt=Math.min(created.session.absoluteExpiresAt,identity.expiresAt);
      created.session.idleExpiresAt=Math.min(created.session.idleExpiresAt,created.session.absoluteExpiresAt);
      return {body:{schema:"desktop.ticket/1",principal},headers:{"Set-Cookie":sessionCookie(d.tls,created.id,Math.max(1,Math.floor((created.session.absoluteExpiresAt-d.clock.now())/1000)))}};
    },
  };
  return handlers;
}
