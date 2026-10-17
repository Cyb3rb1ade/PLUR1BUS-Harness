import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../core/src/core.ts";
import { connect } from "../../core/test/helpers/connect.ts";
import { flatTestInternals } from "../../core/test/helpers/flat-embedder.ts";
import { createCoreLink } from "../src/core-link.ts";
import { createApiServer } from "../src/server.ts";
import { AccountStore,type CorePerson } from "../src/account-store.ts";
import { hashPassword } from "../src/password.ts";
import { memoryAuditSink } from "../src/rbac-bridge.ts";
test("M3 K5 real HTTP budget.set allows Owner/Admin only; Viewer/Member/Operator cannot set or clear, scoped tokens cannot exceed live role",{timeout:60000},async t=>{
 const home=mkdtempSync(join(tmpdir(),"m3-budget-auth-")),cfg=defaults();cfg.engine={neo:{enabled:false},gc:{enabled:false},obsidianBridge:{enabled:false},merging:{enabled:false},dreaming:{enabled:false},skillMiner:{enabled:false},temporalContext:{enabled:false},conversationReactivationRecall:{enabled:false},reranker:{enabled:false}};writeFileSync(join(home,"config.json"),JSON.stringify(cfg));
 const audit=memoryAuditSink(),core=createCore({home,testInternals:flatTestInternals(),rbac:{audit},discovery:{scheduler:false},dreams:{scheduler:false}});await core.start();const local=await connect({address:core.address,token:core.token}),link=createCoreLink(home),accounts=new AccountStore({path:join(home,"state","api","budget-auth.sqlite"),resolve:async userId=>(await link.serviceCall!<{person:CorePerson|null}>("admin.api.person.resolve",{userId})).person});
 t.after(async()=>{await local.close();await link.close();accounts.close();await core.stop({budgetMs:5000});rmSync(home,{recursive:true,force:true});});
 const roles=["owner","admin","operator","member","viewer"] as const,password=randomBytes(24).toString("base64url"),ids=new Map<string,string>();
 for(const role of roles){const userId=role==="owner"?"local-owner":(await local.call<{id:string}>("identity.human.create",{caller:{channel:"cli",accountId:"budget-seed",userId:"owner-fixture"},displayName:`Budget ${role}`})).id;ids.set(role,userId);if(role!=="owner")await local.call("user.role.set",{userId,role});await accounts.createPending(userId,`budget${role}`,await hashPassword(password));await accounts.activate(userId);}
 const api=createApiServer({core:link,accounts,users:accounts,tokens:accounts.tokens,ownerToken:randomBytes(32).toString("hex"),audit,rateClasses:{auth:{capacity:1000,refillPerSec:1000},read:{capacity:1000,refillPerSec:1000},write:{capacity:1000,refillPerSec:1000}}});const{url}=await api.listen();t.after(()=>api.close());
 const login=async(role:string)=>{const r=await fetch(url+"/api/v1/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:`budget${role}`,password})});assert.equal(r.status,200);await r.text();return r.headers.get("set-cookie")!.split(";")[0]!;};const cookies=new Map<string,string>(await Promise.all(roles.map(async role=>[role,await login(role)] as const)));
 const write=async(role:string,path:string,body:object)=>{const cookie=cookies.get(role)!,csrf=await(await fetch(url+"/api/v1/csrf",{headers:{cookie}})).json() as any;return fetch(url+path,{method:"POST",headers:{cookie,"content-type":"application/json","x-csrf-token":csrf.token},body:JSON.stringify(body)});};
 let seq=0;const rpc=async(role:string,method:string,params:object)=>{const r=await write(role,"/rpc",{jsonrpc:"2.0",id:++seq,method,params});assert.equal(r.status,200);return await r.json() as any;};
 const limit=(hard:number|null)=>({limit:{scope:"global",period:"day",metric:"tokens",soft:hard===null?null:Math.floor(hard/2),hard}});
 for(const [n,role]of ["owner","admin"].entries()){const changed=await rpc(role!,"budget.set",{...limit(200+n),timeZone:"UTC"});assert.equal(changed.result.limit.hard,200+n);}
 const baseline=(await rpc("owner","budget.status",{})).result;
 for(const role of ["viewer","member","operator"]){for(const params of [limit(1),limit(null),{timeZone:"Europe/Berlin"}]){const denied=await rpc(role,"budget.set",params);assert.equal(denied.error.data.error,"E_DENIED");}}
 const after=(await rpc("owner","budget.status",{})).result;assert.deepEqual(after.limits,baseline.limits);assert.equal(after.timeZone,baseline.timeZone);
 const token=async(role:string,scope:string)=>{const r=await write(role,"/api/v1/tokens",{name:`budget-${scope}`,scopes:[scope]});assert.equal(r.status,201);return(await r.json() as any).token;};
 const tokenSet=async(token:string,hard:number)=>{const r=await fetch(url+"/rpc",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:++seq,method:"budget.set",params:limit(hard)})});const body=await r.json();return{status:r.status,body};};
 const viewerMint=await write("viewer","/api/v1/tokens",{name:"budget-forbidden",scopes:["settings.write"]});assert.equal(viewerMint.status,403);await viewerMint.text();
 for(const role of ["member","operator"])assert.equal((await tokenSet(await token(role,"settings.write"),2)).status,401);
 assert.equal((await tokenSet(await token("owner","settings.read"),2)).status,401);
 assert.equal((await tokenSet(await token("owner","settings.write"),2)).status,401);
 const adminToken=await token("admin","settings.write");assert.equal((await tokenSet(adminToken,250)).status,401);
 await local.call("user.role.set",{userId:ids.get("admin")!,role:"viewer"});assert.equal((await tokenSet(adminToken,1)).status,401);
 cookies.set("admin",await login("admin"));const demoted=await rpc("admin","budget.set",limit(1));assert.equal(demoted.error.data.error,"E_DENIED");
 const cleared=await rpc("owner","budget.set",limit(null));assert.equal(cleared.result.limit,null);assert.deepEqual(cleared.result.limits,[]);
 assert.ok(audit.events.filter(e=>e.action==="rbac.denied"&&e.target==="budget.set").length>=10);
});
