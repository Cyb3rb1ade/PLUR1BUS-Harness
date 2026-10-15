import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, writeFileSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { RemotePairingController, type PairingTransport } from "../src/remote-pairing-controller.ts";
import { PairCodeStore, createClientNonce, verifyPairProof, pinOf, parsePairingLink } from "../../remote-access/src/index.ts";
import { memoryAuditSink } from "../src/rbac-bridge.ts";
import type { HandlerInput } from "../src/routes.ts";
const LIGHT={memoryKiB:64,passes:1,parallelism:1};
function fixture(t:import("node:test").TestContext){
 const home=mkdtempSync(join(tmpdir(),"pair-controller-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
 let now=1700000000000,current=pinOf(Buffer.from("first cert")),publish:"network"|"tailnet"|"local"="network",live=true,announceFails=false;
 const next=pinOf(Buffer.from("next cert")),ca=pinOf(Buffer.from("same company CA")),calls:string[]=[],devices:any[]=[];
 const audit=memoryAuditSink();let challenge="";const key=generateKeyPairSync("ed25519"),publicKey=key.publicKey.export({type:"spki",format:"der"}).toString("base64");
 const core:any={callAs:async()=>({devices}),serviceCall:async(method:string,p:any)=>{calls.push(method);if(method==="admin.api.person.resolve")return{person:live?{id:"owner-person",role:"owner"}:null};if(method==="admin.api.device.pair"){const device={id:`dev-${devices.length}`,name:p.name,publicKey:p.publicKey,pairedBy:p.pairedBy,scope:p.scope,platform:p.platform};devices.push(device);return{device};}if(method==="admin.api.device.announce"){if(announceFails)throw Error("announce refused");return{announced:true};}if(method==="admin.api.device.challenge"){challenge=Buffer.alloc(32,7).toString("base64url");return{challenge};}if(method==="admin.api.device.prove"){assert.equal(p.publicKey,publicKey);assert.equal(p.signature,sign(null,Buffer.from(challenge,"base64url"),key.privateKey).toString("base64url"));return{device:devices.find(d=>d.id===p.id)};}throw Error(method);}};
 const options={core,audit,now:()=>now,trustFile:join(home,"private","trust.json"),publish:()=>publish,tlsMode:()=>"company-ca" as const,origin:()=>"https://fixture.local",current:()=>({certPin:current,caPin:ca}),transport:(i:HandlerInput)=>i.remoteTransport,stage:async()=>({certPin:next,caPin:ca}),activate:async()=>{calls.push("activate");current=next;},cancelStage:async()=>{},codes:new PairCodeStore({params:LIGHT})};
 const controller=new RemotePairingController(options);
 const transport:PairingTransport={tls:true,origin:options.origin(),servedFingerprint:current};
 const input=(body:object={},over:Partial<HandlerInput>={}):HandlerInput=>({body,ip:"192.0.2.10",rbac:{kind:"person",userId:"owner-person",role:"owner"},remoteTransport:transport,...over} as HandlerInput);
 const pairBody=(offer:any,proof:any,nonce:string)=>({code:offer.code,serverNonce:proof.serverNonce,clientNonce:nonce,name:"Laptop",platform:"macOS",publicKey});
 return{controller,input,pairBody,key,publicKey,devices,calls,audit,options,next,ca,setPublish:(p:typeof publish)=>publish=p,setLive:(v:boolean)=>live=v,setAnnounceFail:(v:boolean)=>announceFails=v,setCurrent:(v:typeof current)=>current=v,tick:(v:number)=>now+=v};
}
test("owner-opened nonce-only certificate proof precedes single-use same-origin redemption",async t=>{
 const f=fixture(t);await assert.rejects(f.controller.proof(f.input({clientNonce:createClientNonce()})),e=>(e as any).status===404);
 const offer=await f.controller.offer(f.input());const nonce=createClientNonce();
 assert.equal(parsePairingLink(offer.link).ok,true);assert.equal(offer.fingerprint,f.options.current().certPin);
 await assert.rejects(f.controller.proof(f.input({clientNonce:nonce,code:offer.code})),e=>(e as any).status===400);
 const proof=await f.controller.proof(f.input({clientNonce:nonce}));assert.equal(verifyPairProof({code:offer.code,response:proof,fingerprintSeen:offer.fingerprint,origin:f.options.origin(),clientNonce:nonce,params:LIGHT}).ok,true);
 const result=await f.controller.pair(f.input(f.pairBody(offer,proof,nonce)));assert.equal(result.device.pairedBy,"owner-person");assert.deepEqual(result.device.scope,["device.trust"]);
 await assert.rejects(f.controller.pair(f.input(f.pairBody(offer,proof,nonce))));assert.equal(f.devices.length,1);
 assert.ok(!JSON.stringify(f.audit.events).includes(offer.code));assert.ok(!JSON.stringify(proof).includes(offer.code));
});
for(const mismatch of ["source","nonce","origin","certificate"] as const)test(`proof receipt refuses ${mismatch} change and is burned`,async t=>{
 const f=fixture(t),offer=await f.controller.offer(f.input()),nonce=createClientNonce(),proof=await f.controller.proof(f.input({clientNonce:nonce})),b=f.pairBody(offer,proof,nonce);
 const over:Partial<HandlerInput>={};if(mismatch==="source")over.ip="192.0.2.11";if(mismatch==="nonce")b.clientNonce=createClientNonce();if(mismatch==="origin")over.remoteTransport={tls:true,origin:"https://wrong.local",servedFingerprint:offer.fingerprint};if(mismatch==="certificate")over.remoteTransport={tls:true,origin:f.options.origin(),servedFingerprint:f.next};
 await assert.rejects(f.controller.pair(f.input(b,over)));assert.equal(f.devices.length,0);
 // Invalid transport is refused before consuming any receipt; it never gives authority.
 if(mismatch==="source"||mismatch==="nonce")await assert.rejects(f.controller.pair(f.input(f.pairBody(offer,proof,nonce))));
});
test("public proof is bounded and does not reopen expired or absent grants",async t=>{
 const f=fixture(t);await f.controller.offer(f.input());for(let n=0;n<10;n++)await f.controller.proof(f.input({clientNonce:createClientNonce()}));await assert.rejects(f.controller.proof(f.input({clientNonce:createClientNonce()})),e=>(e as any).status===429);f.tick(2*60*60*1000);await assert.rejects(f.controller.proof(f.input({clientNonce:createClientNonce()})));assert.equal((await f.controller.status(f.input())).open,false);
});
test("disabled issuer cannot redeem earlier authority; no device is persisted",async t=>{
 const f=fixture(t),offer=await f.controller.offer(f.input()),nonce=createClientNonce(),proof=await f.controller.proof(f.input({clientNonce:nonce}));f.setLive(false);await assert.rejects(f.controller.pair(f.input(f.pairBody(offer,proof,nonce))));assert.equal(f.devices.length,0);
});
test("all management methods require authenticated roles, including trust read and activation",async t=>{
 const f=fixture(t),viewer=f.input({}, {rbac:{kind:"person",userId:"viewer",role:"viewer"}}),anonymous=f.input({}, {rbac:undefined});
 for(const input of [viewer,anonymous])for(const op of [()=>f.controller.offer(input),()=>f.controller.status(input),()=>f.controller.rotate({...input,body:{operation:"stage"}})])await assert.rejects(op);
 await assert.rejects(f.controller.getTrust(anonymous));await assert.rejects(f.controller.challenge(anonymous));await assert.rejects(f.controller.ack(anonymous));
});
test("same-CA leaf renewal announces over old trust before activation and marks missing acknowledgements",async t=>{
 const f=fixture(t);f.devices.push({id:"dev-a",name:"offline",pairedBy:"owner-person",publicKey:f.publicKey});
 const staged:any=await f.controller.rotate(f.input({operation:"stage"}));assert.equal(staged.next?.pin,f.next);assert.equal(staged.next?.kind,"cert");assert.equal(f.options.current().certPin===f.next,false);
 f.setAnnounceFail(true);await assert.rejects(f.controller.rotate(f.input({operation:"activate"})));assert.ok(!f.calls.includes("activate"));f.setAnnounceFail(false);
 const switched:any=await f.controller.rotate(f.input({operation:"activate"}));assert.deepEqual(switched.repairIds,["dev-a"]);assert.equal(f.calls[f.calls.indexOf("activate")-1],"admin.api.device.announce");
 const restarted=new RemotePairingController(f.options);assert.equal((await restarted.getTrust(f.input())).current.pin,f.next);
});
test("trust acknowledgement requires device ownership, one-use challenge and valid private key",async t=>{
 const f=fixture(t);f.devices.push({id:"dev-a",name:"connected",pairedBy:"owner-person",publicKey:f.publicKey});await f.controller.rotate(f.input({operation:"stage"}));await assert.rejects(f.controller.challenge(f.input({deviceId:"foreign"})));
 const proof=await f.controller.challenge(f.input({deviceId:"dev-a"}));const b={deviceId:"dev-a",challenge:proof.challenge,publicKey:f.publicKey,signature:sign(null,Buffer.from(proof.challenge,"base64url"),f.key.privateKey).toString("base64url"),pin:f.next};assert.deepEqual(await f.controller.ack(f.input(b)),{acknowledged:true});await assert.rejects(f.controller.ack(f.input(b)));
 assert.deepEqual(((await f.controller.rotate(f.input({operation:"activate"}))) as any).repairIds,[]);
});
test("tailnet proof requires controlled gateway and client comparison with actual edge TLS leaf",async t=>{
 const f=fixture(t);f.setPublish("tailnet");const offer=await f.controller.offer(f.input()),nonce=createClientNonce();await assert.rejects(f.controller.proof(f.input({clientNonce:nonce})));
 const input=f.input({clientNonce:nonce},{remoteTransport:{tls:false,origin:f.options.origin(),trustedGateway:true}}),proof=await f.controller.proof(input);
 assert.equal(verifyPairProof({code:offer.code,response:proof,origin:f.options.origin(),clientNonce:nonce,fingerprintSeen:f.next,params:LIGHT}).ok,false);
 assert.equal(verifyPairProof({code:offer.code,response:proof,origin:f.options.origin(),clientNonce:nonce,fingerprintSeen:offer.fingerprint,params:LIGHT}).ok,true);
 const parsed=parsePairingLink(offer.link);assert.ok(parsed.ok);const tag=parsed.ok?parsed.offer.tag:"";
 const paired=await f.controller.pair(f.input({code:offer.code,tag,name:"QR",platform:"macOS",publicKey:f.publicKey},{remoteTransport:input.remoteTransport!}));assert.equal(paired.device.name,"QR");
});
test("local publish hides pairing and out-of-band certificate changes fail closed",async t=>{
 const f=fixture(t);f.setPublish("local");assert.equal((await f.controller.status(f.input())).pairingAvailable,false);await assert.rejects(f.controller.offer(f.input()));f.setPublish("network");await f.controller.offer(f.input());f.setCurrent(f.next);await assert.rejects(f.controller.getTrust(f.input()),e=>(e as any).status===503);
});
test("receipt for latest open code cannot redeem another open code",async t=>{
 const f=fixture(t),older=await f.controller.offer(f.input());await f.controller.offer(f.input());const nonce=createClientNonce(),proof=await f.controller.proof(f.input({clientNonce:nonce}));await assert.rejects(f.controller.pair(f.input(f.pairBody(older,proof,nonce))));assert.equal(f.devices.length,0);await assert.rejects(f.controller.pair(f.input(f.pairBody(older,proof,nonce))));
});
test("durable activation intent recovers completed TLS switch after abrupt activation error",async t=>{
 const f=fixture(t);f.devices.push({id:"dev-a",name:"offline",pairedBy:"owner-person",publicKey:f.publicKey});await f.controller.rotate(f.input({operation:"stage"}));f.options.activate=async()=>{f.setCurrent(f.next);throw Error("process stopped after live switch");};await assert.rejects(f.controller.rotate(f.input({operation:"activate"})));const restarted=new RemotePairingController(f.options),state=await restarted.getTrust(f.input());assert.equal(state.current.pin,f.next);assert.equal(state.phase,"switched");assert.deepEqual((state as any).repairIds,["dev-a"]);assert.equal((await restarted.status(f.input())).open,false);
});
test("Viewer cannot write device trust even when the device belongs to that Viewer",async t=>{
 const f=fixture(t);f.devices.push({id:"dev-viewer",name:"view",pairedBy:"viewer",publicKey:f.publicKey});const viewer=f.input({deviceId:"dev-viewer"},{rbac:{kind:"person",userId:"viewer",role:"viewer"}});await assert.rejects(f.controller.challenge(viewer),e=>(e as any).status===403);await assert.rejects(f.controller.ack(viewer),e=>(e as any).status===403);assert.equal(f.calls.length,0);
});
test("failed audit sink prevents grant opening, proof and trust mutation",async t=>{
 const f=fixture(t);f.options.audit={events:[],append:()=>{throw Error("audit unavailable");}};await assert.rejects(f.controller.offer(f.input()));assert.equal(f.controller.codes.open(f.options.now()).length,0);await assert.rejects(f.controller.rotate(f.input({operation:"stage"})));assert.equal(f.calls.length,0);
});

for(const malformed of ["symlink","public-file","oversize"] as const)test(`private trust constructor refuses ${malformed}`,{skip:process.platform==="win32"&&malformed!=="oversize"},async t=>{
 const f=fixture(t);await f.controller.offer(f.input());const path=f.options.trustFile;
 if(malformed==="symlink"){renameSync(path,path+".actual");symlinkSync(path+".actual",path);}else if(malformed==="public-file")chmodSync(path,0o644);else writeFileSync(path," ".repeat(256*1024+1),{mode:0o600});
 assert.throws(()=>new RemotePairingController(f.options),/untrusted-file|remote TLS material unavailable/);
});
