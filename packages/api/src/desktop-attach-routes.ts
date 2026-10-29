import { createHash, randomBytes } from "node:crypto";
import type { CorePerson } from "./account-store.ts";
import type { Handler, HandlerDeps } from "./routes.ts";
import { API_VERSION, sessionCookie } from "./routes.ts";
import { ApiError, errors, fromCoreError } from "./errors.ts";
import type { Session } from "./session.ts";
import { DESKTOP_STEPUP_HEADER, type VerifiedDeviceStepUp } from "./desktop-stepup.ts";

export interface DesktopIdentity { deviceId:string; userId:string; scopes:string[]; expiresAt:number }
export function buildDesktopAttachHandlers(d: HandlerDeps, allowedOrigin:(origin:string)=>boolean) {
  const tickets = new Map<string,{identity:DesktopIdentity;origin:string;expiresAt:number;proof?:VerifiedDeviceStepUp}>();
  const hash = (v:string) => createHash("sha256").update(v).digest("hex");
  const service = async <T>(method:string,p:object):Promise<T> => {
    if(!d.core.serviceCall) throw new ApiError(503,"E_NOT_AVAILABLE","desktop service unavailable");
    try { return await d.core.serviceCall<T>(method,p); } catch(e) { throw fromCoreError(e); }
  };
  const person = async (identity:DesktopIdentity) => {
    const {person} = await service<{person:CorePerson|null}>("admin.api.person.resolve",{userId:identity.userId});
    if(!person || person.disabled || person.userId!==identity.userId) throw errors.unauthenticated("device-person");
    return person;
  };
  const factorRequired = async (identity:DesktopIdentity,p:CorePerson) =>
    !!(d.requireSecondFactor?.(p.role) || await d.totp?.isEnabled(identity.userId) || d.hasPasskeys?.(identity.userId));
  const body = (v:unknown,fields:string[]) => {
    if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==fields.length||Object.keys(v).some(k=>!fields.includes(k)))throw errors.badRequest("body","closed desktop request required");
    const b=v as Record<string,string>;if(fields.some(k=>typeof b[k]!=="string"||!b[k]||b[k]!.length>4096))throw errors.badRequest("body","invalid desktop fields");return b;
  };
  const handlers: Record<string,Handler> = {
    "desktop.meta":async()=>({body:{version:API_VERSION,capabilities:["desktop-pair-v1","desktop-ticket-v1",...d.desktopStepUp?["desktop-stepup-v1"]:[]],pairingRequired:true}}),
    "desktop.pair":async i=>{
      const b=body(i.body,["code","kind","name","publicKey"]);
      const result=await service("admin.api.desktop.redeem",b);
      return {body:{schema:"desktop.pair/1",...result as object}};
    },
    "desktop.redeem":async i=>{
      const b=body(i.body,["token","origin"]);
      if(!allowedOrigin(b.origin!) || i.origin!==undefined && i.origin!==b.origin)throw errors.forbidden("desktop-origin");
      let identity=await service<DesktopIdentity>("admin.api.desktop.token",{token:b.token});
      const p=await person(identity);
      let proof:VerifiedDeviceStepUp|undefined;
      if(i.headers?.[DESKTOP_STEPUP_HEADER]!==undefined || await factorRequired(identity,p)) {
        if(!d.desktopStepUp)throw errors.forbidden("second-factor-required");
        proof=await d.desktopStepUp.verify(b.token!,i.headers?.[DESKTOP_STEPUP_HEADER],"session");
        identity=proof.identity;
      }
      for(const [key,t] of tickets)if(t.expiresAt<=d.clock.now())tickets.delete(key);
      if(tickets.size>=1024)throw errors.rateLimited(30);
      const ticket=randomBytes(32).toString("base64url"),expiresAt=Math.min(identity.expiresAt,d.clock.now()+30_000,proof?.expiresAt??Infinity);
      tickets.set(hash(ticket),{identity,origin:b.origin!,expiresAt,...proof?{proof}:{}});
      return {body:{schema:"desktop.redeem/1",ticket,deviceId:identity.deviceId,expiresAt}};
    },
    "desktop.ticket":async i=>{
      const b=body(i.body,["ticket","deviceId"]),key=hash(b.ticket!),t=tickets.get(key);tickets.delete(key);
      if(!t || t.expiresAt<=d.clock.now() || t.origin!==i.origin || t.identity.deviceId!==b.deviceId)throw errors.unauthenticated("desktop-ticket");
      const identity=await service<DesktopIdentity>("admin.api.desktop.resolve",{deviceId:t.identity.deviceId});
      const p=await person(identity);
      if(identity.userId!==t.identity.userId)throw errors.unauthenticated("device-person");
      if(t.proof) {
        if(!d.desktopStepUp)throw errors.forbidden("second-factor-required");
        await d.desktopStepUp.revalidateTicket(t.proof,identity);
      } else if(await factorRequired(identity,p))throw errors.forbidden("second-factor-required");
      d.sessions.destroy(i.presentedSessionId);
      const principal={kind:"user" as const,id:identity.userId,role:p.role};
      const created=d.sessions.create(principal,{authVersion:p.version,
        device:t.proof?{...identity,scopes:[...t.proof.grantedScopes]}:identity,
        ...t.proof?{stepUpAt:t.proof.stepUpAt}:{}});
      if(t.proof) {
        try {d.desktopStepUp!.bindSession(created.session,t.proof);}
        catch(error) {d.sessions.destroy(created.id);throw error;}
      }
      created.session.absoluteExpiresAt=Math.min(created.session.absoluteExpiresAt,identity.expiresAt);
      created.session.idleExpiresAt=Math.min(created.session.idleExpiresAt,created.session.absoluteExpiresAt);
      return {body:{schema:"desktop.ticket/1",principal},headers:{"Set-Cookie":sessionCookie(d.tls,created.id,Math.max(1,Math.floor((created.session.absoluteExpiresAt-d.clock.now())/1000)))}};
    },
  };
  return handlers;
}
