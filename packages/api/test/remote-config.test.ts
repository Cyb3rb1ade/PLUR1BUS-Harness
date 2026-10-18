import test from "node:test";
import assert from "node:assert/strict";
import { fakeCore,start,login,raw,write,addUser,loginAs } from "./helpers.ts";
test("HTTP remote configuration requires role, explicit audited notice and supervisor CAS",async t=>{
 const core=fakeCore();let remote:Record<string,unknown>={publish:"local",tls:"self-signed",bind:{},allowSubnets:[]};let rev=1;
 core.callAs=async<T>(method:string,params:object,_principal:import("@plur1bus/module-api").ApiPrincipal,endpoint:"core"|"supervisor")=>{
   assert.equal(endpoint,"supervisor");const p=params as any;
   if(method==="config.get")return{value:remote,revision:String(rev)} as T;
   assert.equal(method,"config.set");assert.equal(p.ifRevision,String(rev));for(const c of p.changes)remote={...remote,[c.key.slice(7)]:c.value};rev++;return{applied:true,revision:String(rev)} as T;
 };
 const h=await start({core});t.after(()=>h.close());const {cookie}=await login(h);
 const anonymous=await raw(h,{path:"/api/v1/remote"});assert.equal(anonymous.status,401);
 await addUser(h,{id:"view-remote",username:"viewremote",role:"viewer"});const v=await loginAs(h,"viewremote");const denied=await write(h,v.cookie,{method:"PATCH",path:"/api/v1/remote",body:{publish:"network"}});assert.equal(denied.status,403);
 const initial=await raw(h,{path:"/api/v1/remote",headers:{cookie}});assert.equal(initial.status,200);assert.equal(initial.json.publish,"local");assert.equal(initial.json.noticeRequired,true);assert.ok(initial.json.noticeItems.length>3);
 assert.equal((await write(h,cookie,{method:"PATCH",path:"/api/v1/remote",body:{publish:"network"}})).status,403);assert.equal(remote.publish,"local");
 assert.equal((await write(h,cookie,{path:"/api/v1/remote/confirm",body:{confirmed:false,version:1}})).status,400);
 const confirmation=await write(h,cookie,{path:"/api/v1/remote/confirm",body:{confirmed:true,version:1}});assert.equal(confirmation.status,200);assert.equal(confirmation.json.ack.by,"owner");assert.equal((remote.noticeAck as any).version,1);
 assert.equal((await write(h,cookie,{method:"PATCH",path:"/api/v1/remote",body:{publish:"network",publicOrigin:"http://fixture.local"}})).status,400);
 const changed=await write(h,cookie,{method:"PATCH",path:"/api/v1/remote",body:{publish:"network",publicOrigin:"https://fixture.local",allowSubnets:["10.0.0.0/8"]}});assert.equal(changed.status,200);assert.equal(changed.json.restartRequired,true);assert.equal(remote.publish,"network");
 assert.equal((await write(h,cookie,{method:"PATCH",path:"/api/v1/remote",body:{noticeAck:{by:"forged"}}})).status,400);
 assert.ok(h.audit.events.some(e=>e.action==="remote.notice.confirmed"));assert.ok(h.audit.events.some(e=>e.action==="remote.configuration.changed"));
});
