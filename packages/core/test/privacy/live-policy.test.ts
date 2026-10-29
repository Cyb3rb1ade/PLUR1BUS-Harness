import test from "node:test";
import {EventEmitter} from "node:events";
import assert from "node:assert/strict";
import { defaults, restartPlan, restartClassOf } from "@plur1bus/config-schema";
import { collect, readTool, scriptedAdapter, turnFixture, turnRequest, useTempDirs } from "../composition/helpers.ts";
const tmp=useTempDirs("local-only-live-");

test("installation, agent override and local origins apply live without requesting a Core restart",()=>{
 const before=defaults();before.agents.a1={privacy:{localOnly:false}};
 for(const key of ["privacy.localOnly","privacy.localEndpoints","agents.a1.privacy.localOnly"])assert.equal(restartClassOf(key),"live",key);
 const after=structuredClone(before);after.privacy.localOnly=true;after.privacy.localEndpoints=["http://192.168.1.4:11434"];after.agents.a1!.privacy={localOnly:true};
 const plan=restartPlan(before,after);assert.equal(plan.restart.core,false);assert.deepEqual(plan.restart.modules,[]);
 assert.deepEqual(new Set(plan.restart.live),new Set(["privacy.localOnly","privacy.localEndpoints","agents.a1.privacy.localOnly"]));
});

test("a tool round sees a local-only flip before the next model call; the first response is not aborted",async()=>{
 let localOnly=false,ran=0;
 const cloud=scriptedAdapter([{text:"first response",calls:[{id:"read",name:"file.read",args:{path:"x"}}]},{text:"must not reach the provider"}]);
 const f=turnFixture(cloud.adapter,{localOnly:()=>localOnly,isLocalProvider:()=>false,maxRounds:3},tmp.make());
 f.registry.register(readTool("file.read",async()=>{ran++;localOnly=true;return "read completed";}));
 const chunks:any[]=[];
 try {
  await assert.rejects(async()=>{for await(const c of f.provider.stream(turnRequest()))chunks.push(c);});
  assert.equal(ran,1);assert.ok(chunks.some(c=>c.type==="delta"&&c.text.includes("first response")));
  assert.equal(cloud.requests.length,1,"the second cloud request must not leave the process");
 }finally{f.close();}
});

test("shared-engine decisions agree with the cross-language policy vectors and name the pinning agents",async()=>{
 const {readFileSync}=await import("node:fs");const {sharedEnginePrivacy,assertSharedEnginePrivacy}=await import("../../src/privacy/shared-engine.ts");
 const cases=JSON.parse(readFileSync(new URL("../../../../tests/fixtures/privacy-local-only.json",import.meta.url),"utf8"));
 for(const c of cases){assert.deepEqual(sharedEnginePrivacy(c.config),{required:c.required,agents:c.agents,blocked:c.blocked},c.name);
  if(c.blocked.length)assert.throws(()=>assertSharedEnginePrivacy(c.config),(e:any)=>e.error==="E_DENIED"&&e.reason===(c.agents.length?"local-only-shared-engine":"local-only")&&c.agents.every((id:string)=>e.message.includes(id)));
  else assert.doesNotThrow(()=>assertSharedEnginePrivacy(c.config));
 }
});


// The OS file watcher is best effort (macOS: a change made right after `fs.watch` returns can go unreported while the
// FSEvents stream starts, and bursts are coalesced), so these tests do not depend on it. `silentWatcher` plays an OS that
// reports nothing; the guarantee is the admission read and the stat poll (`FILE_POLL_MS`), whose interval bounds the waits.
async function standalone(opts:{filePollMs:number;silent:boolean}){
 const {writeFileSync,mkdirSync}=await import("node:fs");
 const {layout}=await import("../../src/paths.ts");
 const {openConfigSource}=await import("../../src/config-source.ts");
 const l=layout(tmp.make());mkdirSync(l.home,{recursive:true});
 const cfg=defaults();writeFileSync(l.configPath,JSON.stringify(cfg));
 const silentWatcher=((()=>{const w:any=new EventEmitter();w.unref=()=>w;w.close=()=>{};return w;}) as any);
 const source=await openConfigSource({layout:l,supervised:false,filePollMs:opts.filePollMs,...(opts.silent?{watchDirectory:silentWatcher}:{})});
 const edit=()=>{cfg.privacy.localOnly=true;cfg.privacy.localEndpoints=["http://192.168.1.4:11434"];writeFileSync(l.configPath,JSON.stringify(cfg));};
 return {source,cfg,edit};
}
for(const silent of [false,true])test(`standalone file policy reaches the listeners within the poll interval${silent?", with an OS watcher that reports nothing":""}`,async()=>{
 const pollMs=100;const {source,cfg,edit}=await standalone({filePollMs:pollMs,silent});
 try {
  let changes=0;source.onChange(()=>changes++);
  const observed=new Promise<void>((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(new Error("standalone live config event did not arrive")),30*pollMs);
   const off=source.onChange(()=>{clearTimeout(timeout);off();resolve();});
  });
  edit();
  await observed;
  assert.equal(source.current().privacy.localOnly,true);assert.equal(changes,1,"one change, however many of watcher, poll and admission read saw it");
  assert.equal(source.restartPending(),false);
  assert.deepEqual(source.current().privacy.localEndpoints,cfg.privacy.localEndpoints);
 } finally {await source.close();}
});

test("standalone file policy refreshes on the next admission read, without a Core restart or any watcher event", async () => {
 const {source,cfg,edit}=await standalone({filePollMs:3_600_000,silent:true});
 try {
  let changes=0;source.onChange(()=>changes++);
  assert.equal(source.current().privacy.localOnly,false);
  edit();
  assert.equal(source.current().privacy.localOnly,true,"the read right after the write sees it");
  assert.equal(changes,1);assert.equal(source.restartPending(),false);
  assert.deepEqual(source.current().privacy.localEndpoints,cfg.privacy.localEndpoints);assert.equal(changes,1);
 } finally {await source.close();}
});

test("a proposed local engine cannot hide the cloud engine still bound to the running process",async()=>{
 const {assertSharedEnginePrivacy}=await import("../../src/privacy/shared-engine.ts");
 const next=defaults();next.privacy.localOnly=true;
 assert.doesNotThrow(()=>assertSharedEnginePrivacy(next));
 assert.throws(()=>assertSharedEnginePrivacy(next,{embedding:{provider:"openai"}}),/must use local endpoints/);
});

test.todo("KNOWN GAP C/D: settle reembed tokens and cost from actual provider usage after the approved Engine 1.15 host network port is wired (currently estimated)");


test.todo("KNOWN GAP C/D: automatically schedule engine-only restart with restartPending and Web/CLI hint when a live privacy transition needs Engine hot reconfiguration");


test("an admitted cloud response finishes after the live switch changes mid-stream", async () => {
 let localOnly=false;
 const cloud=scriptedAdapter([{streamed:["first", "second"],text:"firstsecond"}]);
 const stream=cloud.adapter.stream.bind(cloud.adapter);
 cloud.adapter.stream=async function*(request,options){
  let seen=false;for await(const chunk of stream(request,options)){yield chunk;if(!seen){seen=true;localOnly=true;}}
 };
 const f=turnFixture(cloud.adapter,{localOnly:()=>localOnly,isLocalProvider:()=>false},tmp.make());
 try {
  const chunks=await collect(f.provider);
  assert.ok(chunks.some(c=>c.type==="delta"&&c.text.includes("second")));
  assert.equal(cloud.requests.length,1);
  await assert.rejects(async()=>collect(f.provider));
  assert.equal(cloud.requests.length,1);
 }finally{f.close();}
});
