import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCreateSaga, creationDigest, type SagaRecord } from "../../src/agents/saga.ts";
const record = (): SagaRecord => ({ version:1,key:"request-for-alpha-1",actor:"owner",digest:creationDigest({name:"alpha"}),agentId:"alpha",attempted:0,state:"running",payload:{} });
for (let fail = 0; fail < 4; fail++) test(`failure in step ${fail+1} compensates attempted effects in reverse order`, async t => {
 const path=mkdtempSync(join(tmpdir(),"saga-"));t.after(()=>rmSync(path,{recursive:true,force:true}));
 const saga=new AgentCreateSaga(path), live=new Set<number>(), undo:number[]=[];
 const steps=[0,1,2,3].map(i=>({name:String(i),apply:async()=>{live.add(i);if(i===fail)throw Error("injected");},undo:async()=>{undo.push(i);live.delete(i);}}));
 await assert.rejects(saga.provision(record(),steps));assert.equal(live.size,0);assert.deepEqual(undo,Array.from({length:fail+1},(_,i)=>fail-i));
 assert.equal(saga.find(record().key,"owner")!.state,"compensated");
});
test("fresh process recovers durable intent when compensation itself was interrupted",async t=>{
 const path=mkdtempSync(join(tmpdir(),"saga-"));t.after(()=>rmSync(path,{recursive:true,force:true}));let refused=true;const live=new Set<number>();
 const steps=[0,1,2,3].map(i=>({name:String(i),apply:async()=>{live.add(i);if(i===2)throw Error("crash");},undo:async()=>{if(refused)throw Error("storage-offline");live.delete(i);}}));
 await assert.rejects(new AgentCreateSaga(path).provision(record(),steps));refused=false;
 const restarted=new AgentCreateSaga(path);assert.equal(restarted.pending().length,1);await restarted.compensate(restarted.pending()[0]!,steps);
 assert.equal(live.size,0);assert.equal(restarted.pending().length,0);
});

for (let crash=0;crash<4;crash++) test(`process exits after step ${crash+1}; a fresh journal reverses durable effects`, async t=>{
 const path=mkdtempSync(join(tmpdir(),"saga-crash-"));t.after(()=>rmSync(path,{recursive:true,force:true}));
 const {spawnSync}=await import("node:child_process"),fs=await import("node:fs"),module=new URL("../../src/agents/saga.ts",import.meta.url).href;
 const child=`import {AgentCreateSaga} from ${JSON.stringify(module)};import {writeFileSync} from 'node:fs';import {join} from 'node:path';const path=${JSON.stringify(path)};const steps=[0,1,2,3].map(i=>({name:String(i),apply:async()=>{writeFileSync(join(path,'effect-'+i),'present');if(i===${crash})process.exit(88);},undo:async()=>{}}));await new AgentCreateSaga(path).provision(${JSON.stringify(record())},steps);`;
 const killed=spawnSync(process.execPath,["--experimental-strip-types","--conditions=source","--input-type=module","-e",child]);assert.equal(killed.status,88,killed.stderr.toString());
 const restarted=new AgentCreateSaga(path),pending=restarted.pending();assert.equal(pending.length,1);assert.equal(pending[0]!.attempted,crash+1);
 await restarted.compensate(pending[0]!,[0,1,2,3].map(i=>({name:String(i),apply:async()=>{},undo:async()=>{fs.rmSync(join(path,`effect-${i}`),{force:true});}})));
 for(let i=0;i<4;i++)assert.equal(fs.existsSync(join(path,`effect-${i}`)),false);assert.equal(restarted.pending().length,0);
});

// Windows: fsync is FlushFileBuffers, which needs write access to the handle. A file opened read-only ("r") fails there with
// EPERM, which agent.create reported as "E_STORAGE: agent provisioning unavailable" (hermes-host real-hermes, windows-2025).
// Linux accepts fsync on a read-only fd, so the test pins the open flags of every fsynced file instead.
test("every journal file is fsynced through a writable handle (FlushFileBuffers needs write access on Windows)", async t => {
 const fs=(await import("node:fs")).default,{syncBuiltinESMExports}=await import("node:module");
 const path=mkdtempSync(join(tmpdir(),"saga-"));t.after(()=>rmSync(path,{recursive:true,force:true}));
 const flags=new Map<number,{path:string;flags:unknown}>(),synced:{path:string;flags:unknown}[]=[],dirs:string[]=[];
 const realOpen=fs.openSync,realFsync=fs.fsyncSync;
 t.mock.method(fs,"openSync",((p:string,f:unknown,...rest:unknown[])=>{const fd=(realOpen as any)(p,f,...rest);flags.set(fd,{path:String(p),flags:f});return fd;}) as typeof fs.openSync);
 t.mock.method(fs,"fsyncSync",((fd:number)=>{const o=flags.get(fd);if(o)synced.push(o);return realFsync(fd);}) as typeof fs.fsyncSync);
 syncBuiltinESMExports();t.after(()=>syncBuiltinESMExports());
 new AgentCreateSaga(path).markActivated(record());
 for(const o of synced.splice(0)){if(o.path===join(path,"agent-create"))dirs.push(o.path);else assert.match(String(o.flags),/^(r\+|a\+?|w\+?|wx\+?|ax\+?)$/,`${o.path} is fsynced through a read-only handle (flags ${String(o.flags)})`);}
 assert.ok(flags.size>0,"the journal write opened nothing");
});
