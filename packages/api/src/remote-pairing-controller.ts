import { dirname } from "node:path";
// Pairing bootstrap is deliberately separate from cookie authentication. It can only redeem a grant opened by an
// authenticated Owner/Admin, over the configured TLS origin, after certificate proof or a reviewed tailnet QR tag.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { PairCodeStore, buildPairingOffer, offerTag, encodePairingLink, qrData, handlePairProof, createProofLimiter, initTrust, stageTrust, switchTrust, cancelTrust, ackTrust, announcementFor, trustProgress, trustNextEvent, trustForNewPairing, parseTrust, serializeTrust, pinsEqual, parsePin, type Pin, type Anchor, type TrustState, type SignedOffer, type TrustDevice, type PublishMode, type TlsMode, type TrustNextEvent } from "../../remote-access/src/index.ts";
import type { Device } from "../../remote-access/src/device-store.ts";
import { privateAtomicJson } from "./remote-certificates.ts";
import type { HandlerInput } from "./routes.ts";
import type { CoreRpc } from "./core-rpc.ts";
import { authorize, type AuditSink } from "./rbac-bridge.ts";
import { webPrincipal, webConnection } from "./principal.ts";
import { ApiError, errors, fromCoreError } from "./errors.ts";
export interface PairingCertificate { certPin: Pin; caPin?: Pin }
export interface PairingTransport {
 tls: boolean; origin: string; servedFingerprint?: Pin;
 /** Only the locally controlled Tailscale serve backend can set this, never a forwarded header. */
 trustedGateway?: boolean;
}
export interface RemotePairingOptions {
 core: CoreRpc; audit: AuditSink; now(): number; trustFile: string;
 publish(): PublishMode; tlsMode(): TlsMode; origin(): string;
 current(): PairingCertificate | undefined | Promise<PairingCertificate | undefined>;
 transport(input: HandlerInput): PairingTransport | undefined;
 stage(): Promise<PairingCertificate>; activate(): Promise<void>; cancelStage(): Promise<void>;
 /** Optional testing seam; production uses the existing Argon2id code store. */
 codes?: PairCodeStore;
}
interface Grant { actor: ReturnType<typeof webPrincipal>; expiresAt: number; fingerprint: Pin; origin: string; tag: string }
interface Receipt { codeId: string; source: string; fingerprint: Pin; origin: string; clientNonce: string; expiresAt: number }
interface Challenge { deviceId: string; source: string; fingerprint: Pin; origin: string; expiresAt: number }
interface StoredTrust { version: 1; state: TrustState; activation?: { devices: TrustDevice[]; at: number } }
const sameSecret=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
const obj=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==="object" && !Array.isArray(v);
const invalid=()=>errors.badRequest("pairing-request","invalid pairing request");
function body(v:unknown,allowed:readonly string[]):Record<string,unknown>{if(!obj(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw invalid();return v;}
function field(b:Record<string,unknown>,key:string,max=128):string{const v=b[key];if(typeof v!=="string"||!v.trim()||v.length>max||/[\u0000-\u001f\u007f]/.test(v))throw invalid();return v;}
export class RemotePairingController {
 readonly codes:PairCodeStore; private options:RemotePairingOptions; private key=randomBytes(32); private grants=new Map<string,Grant>();
 private receipts=new Map<string,Receipt>(); private challenges=new Map<string,Challenge>();private proofLimiter=createProofLimiter();private stored?:StoredTrust;
 private queue:Promise<unknown>=Promise.resolve();
 constructor(options:RemotePairingOptions){this.options=options;this.codes=options.codes??new PairCodeStore({});
  if(existsSync(options.trustFile)){const raw=JSON.parse(readFileSync(options.trustFile,"utf8")) as StoredTrust;const parsed=parseTrust(serializeTrust(raw.state));if(raw.version!==1||!parsed.ok)throw new Error("remote trust state unavailable");this.stored={...raw,state:parsed.state};}
 }
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
 private audit(action:string,actor:string,detail:Record<string,unknown>={}){this.options.audit.append({at:this.options.now(),actor:{user:actor,host:"api"},action,target:"remote-pairing",detail});}
 private admin(i:HandlerInput){if(!i.rbac||i.rbac.kind!=="person"||authorize(i.rbac,"admin.pairing.read",{kind:"system"}).effect!=="allow")throw errors.forbidden("role-denied");return webPrincipal(i.rbac,i.principal?.kind==="owner");}
 private person(i:HandlerInput,write=false){if(!i.rbac||i.rbac.kind!=="person"||authorize(i.rbac,write?"remote.device.write":"device.list",{kind:"system"}).effect!=="allow")throw errors.forbidden("role-denied");return webPrincipal(i.rbac,i.principal?.kind==="owner");}
 private save(state:TrustState,activation?:StoredTrust["activation"]){const next:StoredTrust={version:1,state,...(activation?{activation}:{})};mkdirSync(dirname(this.options.trustFile),{recursive:true,mode:0o700});privateAtomicJson(this.options.trustFile,next);this.stored=next;}
 private prune(){const now=this.options.now();for(const[id,g]of this.grants)if(now>=g.expiresAt){this.codes.revoke(id);this.grants.delete(id);}for(const[id,r]of this.receipts)if(now>=r.expiresAt)this.receipts.delete(id);for(const[id,r]of this.challenges)if(now>=r.expiresAt)this.challenges.delete(id);}
 private async certificate(){if(this.options.publish()==="local")throw new ApiError(404,"E_NOT_AVAILABLE","pairing is hidden in local mode",{reason:"remote-local"});const current=await this.options.current();if(!current||!parsePin(current.certPin))throw new ApiError(503,"E_NOT_AVAILABLE","verified served certificate fingerprint unavailable",{reason:"pairing-fingerprint-unavailable"});return current;}
 private async trust(){const cert=await this.certificate(),anchor:Anchor={kind:"cert",pin:cert.certPin};
  if(!this.stored)this.save(initTrust(anchor));let state=this.stored!.state;
  if(!pinsEqual(state.current.pin,anchor.pin)){
   if(this.stored!.activation&&state.phase==="staged"&&state.next&&pinsEqual(state.next.pin,anchor.pin)){const recovered=switchTrust(state,this.stored!.activation.devices,this.options.now());if(!recovered.ok)throw new Error("trust recovery unavailable");this.save(recovered.state);state=recovered.state;}
   else throw new ApiError(503,"E_STORAGE","certificate changed without staged trust",{reason:"trust-state-mismatch"});
  }return {cert,state};
 }
 private async transport(i:HandlerInput,typed=false){const cert=await this.certificate(),t=this.options.transport(i),origin=this.options.origin();
  if(!t||t.origin!==origin)throw errors.forbidden("pairing-origin");
  if(this.options.publish()==="tailnet"){
   // A bounded CA/hostname-verified edge probe supplies this public leaf snapshot. The HMAC is NOT TLS authority:
   // verifyPairProof on the client must match its ACTUAL leaf and configured origin before disclosing the code.
   // A stale snapshot therefore refuses pairing. No forwarded header supplies any trust fact.
   if(!t.trustedGateway)throw errors.forbidden("pairing-tls");return {cert,fingerprint:cert.certPin,origin};
  }
  if(!t.tls||!t.servedFingerprint||!pinsEqual(t.servedFingerprint,cert.certPin))throw errors.forbidden(typed&&this.options.publish()==="tailnet"?"typed-proof-unavailable":"pairing-tls");
  return {cert,fingerprint:t.servedFingerprint,origin};
 }
 private async service<T>(method:string,p:object):Promise<T>{if(!this.options.core.serviceCall)throw new ApiError(503,"E_NOT_AVAILABLE","core device service unavailable");try{return await this.options.core.serviceCall<T>(method,p);}catch(e){throw fromCoreError(e);}}
 private async devices(i:HandlerInput):Promise<Device[]>{const who=this.person(i);if(!this.options.core.callAs)throw new ApiError(503,"E_NOT_AVAILABLE","core delegation unavailable");return (await this.options.core.callAs<{devices:Device[]}>("device.list",{},who,"core",i.session?webConnection(i.session):undefined)).devices.filter(d=>!d.revoked);}
 async status(i:HandlerInput){this.admin(i);this.prune();const publish=this.options.publish();if(publish==="local")return {publish,pairingAvailable:false,open:false,pending:0};const cert=await this.options.current();return {publish,pairingAvailable:!!cert,open:this.codes.open(this.options.now()).length>0,pending:this.codes.open(this.options.now()).length,...(cert?{fingerprint:cert.certPin}:{})};}
 offer(i:HandlerInput){return this.serial(async()=>{const actor=this.admin(i);body(i.body,[]);this.prune();const {cert,state}=await this.trust();this.audit("device.pairing.opened",actor.userId);
  const made=buildPairingOffer({store:this.codes,now:this.options.now(),publish:this.options.publish(),tls:this.options.tlsMode(),origins:[this.options.origin()],signKey:this.key,...trustForNewPairing(state)});
  if(!made.ok)throw errors.badRequest("pairing-offer-unavailable","remote pairing operation refused");
  // Include the verified leaf fingerprint in every payload, including CA-verified tailnet QR pairing.
  const unsigned={...made.offer,certPin:cert.certPin,...(cert.caPin?{caPin:cert.caPin}:{})};const offer:SignedOffer={...unsigned,tag:offerTag(unsigned,this.key)};const link=encodePairingLink(offer),id=this.codes.open(this.options.now())[0]!.id;
  this.grants.set(id,{actor,expiresAt:offer.expiresAt,fingerprint:cert.certPin,origin:this.options.origin(),tag:offer.tag});
  return {id,link,qr:qrData(link),code:offer.code,expiresAt:offer.expiresAt,fingerprint:cert.certPin,...(cert.caPin?{caPin:cert.caPin}:{})};
 });}
 async proof(i:HandlerInput){this.prune();const ctx=await this.transport(i,true);this.audit("device.pairing.proof","pairing-bootstrap");
  const result=handlePairProof(i.body,{store:this.codes,now:this.options.now(),origin:ctx.origin,servedFingerprint:ctx.fingerprint,...(ctx.cert.caPin?{caPin:ctx.cert.caPin}:{}),source:i.ip,limiter:this.proofLimiter});
  if(result.status!==200)throw new ApiError(result.status,result.status===400?"E_INVALID_PARAMS":result.status===404?"E_NOT_FOUND":"E_DENIED","pairing proof unavailable",{reason:result.body.code,...(result.body.retryAfterMs?{headers:{"Retry-After":String(Math.ceil(result.body.retryAfterMs/1000))}}:{})});
  const code=this.codes.open(this.options.now())[0];if(!code||!this.grants.has(code.id))throw errors.notFound();
  if(this.receipts.size>=1000)throw errors.rateLimited(60);
  this.receipts.set(result.body.serverNonce,{codeId:code.id,source:i.ip,fingerprint:ctx.fingerprint,origin:ctx.origin,clientNonce:(i.body as any).clientNonce,expiresAt:Math.min(code.expiresAt,this.options.now()+60_000)});
  return result.body;
 }
 pair(i:HandlerInput){return this.serial(async()=>{this.prune();const b=body(i.body,["code","serverNonce","clientNonce","tag","name","platform","publicKey"]),ctx=await this.transport(i);let grantId:string|undefined;
  if(this.options.publish()==="tailnet"&&typeof b.tag==="string"){
   // QR-only exception: normal CA/hostname-verified configured tailnet origin + owner-issued HMAC offer tag.
   grantId=[...this.grants].find(([,g])=>sameSecret(g.tag,b.tag as string))?.[0];
  }else{
   const nonce=field(b,"serverNonce"),receipt=this.receipts.get(nonce);this.receipts.delete(nonce);
   if(!receipt||receipt.source!==i.ip||receipt.origin!==ctx.origin||!pinsEqual(receipt.fingerprint,ctx.fingerprint)||receipt.clientNonce!==b.clientNonce)throw errors.forbidden("pairing-proof-required");grantId=receipt.codeId;
  }
  const grant=grantId?this.grants.get(grantId):undefined;if(!grant||grant.origin!==ctx.origin||!pinsEqual(grant.fingerprint,ctx.fingerprint))throw errors.forbidden("pairing-grant");
  const name=field(b,"name"),platform=field(b,"platform",64),publicKey=field(b,"publicKey",4096),code=field(b,"code",64);
  this.audit("device.pairing.redeem",grant.actor.userId);
  const redeemed=this.codes.redeem(code,this.options.now(),i.ip);
  if(!redeemed.ok)throw redeemed.reason==="locked"?errors.locked(Math.ceil(redeemed.retryAfterMs/1000)):errors.forbidden("pairing-code");
  if(redeemed.id!==grantId){this.grants.delete(redeemed.id);throw errors.forbidden("pairing-code");}this.grants.delete(grantId!);
  // An opening account may have been disabled or demoted; the stored grant cannot restore its authority.
  const live=await this.service<{person:{id:string;role:string;disabled?:boolean}|null}>("admin.api.person.resolve",{userId:grant.actor.userId});if(!live.person||live.person.disabled||!["owner","admin"].includes(live.person.role))throw errors.forbidden("pairing-issuer-revoked");
  return this.service<{device:Device}>("admin.api.device.pair",{name,platform,publicKey,pairedBy:grant.actor.userId,scope:["device.trust"]});
 });}
 async getTrust(i:HandlerInput){this.person(i);const {state}=await this.trust(),devices=await this.devices(i);this.audit("device.trust.read",webPrincipal(i.rbac!,i.principal?.kind==="owner").userId);return {...announcementFor(state),...(state.phase==="switched"?{phase:"switched" as const,repairIds:(state.repairIds??[]).filter(id=>devices.some(d=>d.id===id))}:{}),progress:trustProgress(state,devices)};}
 async challenge(i:HandlerInput){this.person(i,true);this.prune();const b=body(i.body,["deviceId"]),id=field(b,"deviceId"),devices=await this.devices(i);if(!devices.some(d=>d.id===id))throw errors.forbidden("device-owner");const ctx=await this.transport(i);const made=await this.service<{challenge:string}>("admin.api.device.challenge",{});if(this.challenges.size>=1000)throw errors.rateLimited(30);this.challenges.set(made.challenge,{deviceId:id,source:i.ip,fingerprint:ctx.fingerprint,origin:ctx.origin,expiresAt:this.options.now()+30_000});return {...made,expiresAt:this.options.now()+30_000,current:(await this.trust()).state.current,origin:ctx.origin};}
 ack(i:HandlerInput){return this.serial(async()=>{this.person(i,true);this.prune();const b=body(i.body,["deviceId","publicKey","challenge","signature","pin"]),id=field(b,"deviceId"),challenge=field(b,"challenge"),pending=this.challenges.get(challenge);this.challenges.delete(challenge);const ctx=await this.transport(i);if(!pending||pending.deviceId!==id||pending.source!==i.ip||pending.origin!==ctx.origin||!pinsEqual(pending.fingerprint,ctx.fingerprint))throw errors.forbidden("device-proof");
  const devices=await this.devices(i);if(!devices.some(d=>d.id===id))throw errors.forbidden("device-owner");await this.service("admin.api.device.prove",{id,publicKey:field(b,"publicKey",4096),challenge,signature:field(b,"signature")});const {state}=await this.trust();const next=ackTrust(state,{deviceId:id,pin:field(b,"pin") as Pin,now:this.options.now(),paired:devices.map(d=>d.id)});if(!next.ok)throw errors.forbidden("trust-ack");this.audit("device.trust.acknowledged",webPrincipal(i.rbac!,i.principal?.kind==="owner").userId);this.save(next.state);return {acknowledged:true};
 });}
 rotate(i:HandlerInput){return this.serial(async()=>{const actor=this.admin(i),b=body(i.body,["operation"]),operation=field(b,"operation"),{state}=await this.trust();this.audit("device.trust.rotate",actor.userId,{operation:operation==="stage"||operation==="activate"||operation==="cancel"?operation:"invalid"});
  if(operation==="stage"){const material=await this.options.stage(),next:Anchor={kind:"cert",pin:material.certPin};const staged=stageTrust(state,next,this.options.now());if(!staged.ok)throw errors.badRequest("trust-stage","remote pairing operation refused");this.save(staged.state);const event=trustNextEvent(staged.state)!;await this.service("admin.api.device.announce",{next:event.next,stagedAt:event.stagedAt});return {...announcementFor(staged.state),progress:trustProgress(staged.state,await this.devices(i))};}
  if(operation==="cancel"){const cancelled=cancelTrust(state);if(!cancelled.ok)throw errors.badRequest("trust-cancel","remote pairing operation refused");await this.options.cancelStage();this.save(cancelled.state);return announcementFor(cancelled.state);}
  if(operation!=="activate"||state.phase!=="staged")throw errors.badRequest("trust-activate","remote pairing operation refused");const devices=await this.devices(i);const event=trustNextEvent(state)!;await this.service("admin.api.device.announce",{next:event.next,stagedAt:event.stagedAt});this.save(state,{devices:devices.map(d=>({id:d.id,name:d.name})),at:this.options.now()});await this.options.activate();const switched=switchTrust(state,devices,this.options.now());if(!switched.ok)throw errors.badRequest("trust-activate","remote pairing operation refused");this.save(switched.state);for(const id of this.grants.keys())this.codes.revoke(id);this.grants.clear();this.receipts.clear();this.challenges.clear();return {...announcementFor(switched.state),repairIds:switched.state.repairIds??[]};
 });}
}
