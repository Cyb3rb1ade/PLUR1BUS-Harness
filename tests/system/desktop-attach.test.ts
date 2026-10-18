import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, home, startDaemon, waitFor, reapHome, daemonStatus } from "./helpers.ts";

test("supervisor → loopback meta → CLI pair → redeem → SPA ticket; revoke, API restart and stop cleanup",{timeout:60000},async()=>{
 const h=home();
 try {
  cli(h,["agent","create","main"]);
  startDaemon(h); // Resolve the API bundled beside core.js, as in the installed atomic runtime payload.
  const api=await waitFor("verified api.json",()=>{try{return JSON.parse(readFileSync(join(h,"run","api.json"),"utf8"));}catch{return false;}},30000);
  assert.equal(api.address,"127.0.0.1");assert.equal(api.version,"1.0.0");assert.equal(api.fingerprint,null);
  if(process.platform!=="win32")assert.equal(statSync(join(h,"run","api.json")).mode&0o777,0o600);
  assert.equal(daemonStatus(h).children.find((c:any)=>c.role==="api").kind,"api");
  const url=`http://${api.address}:${api.port}`;
  const post=(path:string,body:object,headers:Record<string,string>={})=>fetch(url+path,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
  const meta=await (await fetch(url+"/api/v1/meta")).json() as any;assert.equal(meta.pairingRequired,true);
  const grant=await waitFor("Core ready for CLI pairing",()=>{const result=cli(h,["device","pair","--kind","desktop"],{allowFail:true});return result.code&&result;},30000);
  assert.equal(grant.schema,"device.pair/1");
  const publicKey=generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"der"}).toString("base64");
  const paired=await post("/api/v1/desktop/pair",{code:grant.code,kind:"desktop",name:"System desktop",publicKey});assert.equal(paired.status,200,await paired.clone().text());const device=await paired.json() as any;
  const redemption=await post("/api/v1/desktop/redeem",{token:device.token,origin:url});assert.equal(redemption.status,200,await redemption.clone().text());const ticket=await redemption.json() as any;
  const session=await post("/api/v1/desktop/ticket",{ticket:ticket.ticket,deviceId:device.device.id},{origin:url});assert.equal(session.status,200,await session.clone().text());const cookie=session.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await fetch(url+"/api/v1/whoami",{headers:{cookie}})).status,200);
  cli(h,["device","revoke",device.device.id]);
  assert.equal((await fetch(url+"/api/v1/whoami",{headers:{cookie}})).status,401);
  assert.ok(!existsSync(join(h,"run","api-owner.token")),"supervised startup never creates the discarded attach credential");
  const check=cli(h,["1staid","check"],{allowFail:true});const doc=check.stdout?JSON.parse(check.stdout):check;
  assert.equal(doc.checks.find((c:any)=>c.id==="api.supervised").status,"ok");
  process.kill(api.pid,"SIGTERM");
  const next=await waitFor("API restart after unexpected exit",()=>{try{const r=JSON.parse(readFileSync(join(h,"run","api.json"),"utf8"));return r.pid!==api.pid&&r;}catch{return false;}},15000);
  assert.notEqual(next.pid,api.pid);
  cli(h,["daemon","stop"]);
  await waitFor("private API publication removed",()=>!existsSync(join(h,"run","api.json")),10000);
 } finally {cli(h,["daemon","stop"],{allowFail:true});await reapHome(h);rmSync(h,{recursive:true,force:true});}
});


test("daemon start rearms a repaired API payload while preserving the healthy Core",{timeout:60000},async()=>{
 const h=home(),entry=join(h,"repaired-api.mjs");
 try {
  cli(h,["agent","create","main"]);
  startDaemon(h,{PLUR1BUS_API_JS:entry});
  const before=await waitFor("failed API beside healthy Core",()=>{
   const status=daemonStatus(h),core=status.children?.find((c:any)=>c.role==="core"),api=status.children?.find((c:any)=>c.role==="api");
   return core?.process.state==="ready"&&api?.process.state==="crashed"&&core.pid;
  },30000);
  writeFileSync(entry,readFileSync("crates/plur1bus/tests/fixtures/fake-api.mjs","utf8"));
  cli(h,["daemon","start"]);
  await waitFor("repaired API is supervised",()=>existsSync(join(h,"run","api.json")),10000);
  const status=daemonStatus(h);assert.equal(status.children.find((c:any)=>c.role==="core").pid,before);
  assert.equal(status.children.find((c:any)=>c.role==="api").process.state,"ready");
 }finally{cli(h,["daemon","stop"],{allowFail:true});await reapHome(h);rmSync(h,{recursive:true,force:true});}
});
