import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../core/src/core.ts";
import { FakeChatProvider } from "../../core/src/session/provider.ts";
import { flatTestInternals } from "../../core/test/helpers/flat-embedder.ts";
import { layout } from "../../core/src/paths.ts";
import { AdminStore } from "../../core/src/identity/admin-store.ts";
import { memoryAuditSink } from "../src/rbac-bridge.ts";
import { createApiServer } from "../src/server.ts";
import { createCoreLink } from "../src/core-link.ts";
import { MemoryUserDirectory } from "../src/memory-stores.ts";
import { hashPassword } from "../src/password.ts";

async function setup(t: import("node:test").TestContext) {
  const home=mkdtempSync(join(tmpdir(),"p1b-http-chats-"));const cfg=defaults();cfg.agents.bernd={};cfg.agents.anna={};
  cfg.engine={neo:{enabled:false},gc:{enabled:false},obsidianBridge:{enabled:false},merging:{enabled:false},dreaming:{enabled:false},skillMiner:{enabled:false},temporalContext:{enabled:false},reranker:{enabled:false},duplicateThreshold:1.01};
  writeFileSync(layout(home).configPath,JSON.stringify(cfg));
  const people=new AdminStore({path:join(home,"state","admin.sqlite"),ownerId:"local-owner"});
  for(const [id,role] of [["alice","member"],["bob","member"],["viewer","viewer"],["ops","operator"],["admin","admin"]] as const){people.setRole(id,role,()=>{});people.setRight("bernd",id,"use");}people.close();
  const audit=memoryAuditSink();const core=createCore({home,testInternals:flatTestInternals(),chatProvider:new FakeChatProvider(),rbac:{audit},discovery:{scheduler:false},dreams:{scheduler:false}});await core.start();
  const link=createCoreLink(home);const users=new MemoryUserDirectory();const password="fixture-pass-not-a-real-secret";
  for(const [id,role] of [["alice","member"],["bob","member"],["viewer","viewer"],["ops","operator"],["admin","admin"]] as const)users.add({id,username:id,role,agentRights:{bernd:"use"},passwordHash:await hashPassword(password)});
  const api=createApiServer({core:link,users,ownerToken:randomBytes(32).toString("hex"),audit});const {url}=await api.listen();
  t.after(async()=>{await api.close();await link.close();await core.stop({budgetMs:5000});rmSync(home,{recursive:true,force:true});});
  const login=async(name:string)=>{const r=await fetch(url+"/api/v1/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:name,password})});assert.equal(r.status,200);await r.text();return r.headers.get("set-cookie")!.split(";")[0]!;};
  const call=async(cookie:string,path:string,method="GET",body?:object,extra:Record<string,string>={})=>{
    let csrf:string|undefined;if(method!=="GET"){const r=await fetch(url+"/api/v1/csrf",{headers:{cookie}});csrf=(await r.json() as {token:string}).token;}
    return fetch(url+path,{method,headers:{cookie,...(csrf?{"x-csrf-token":csrf}:{}),...(body?{"content-type":"application/json"}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
  };
  return {home,url,core,audit,users,api,login,call};
}
test("real HTTP/core chat lifecycle, streaming, isolation, scopes and archive-first identity-bound delete",{timeout:30000},async t=>{
  const h=await setup(t),alice=await h.login("alice"),bob=await h.login("bob"),viewer=await h.login("viewer");
  const create=await h.call(alice,"/api/v1/chats","POST",{agentId:"bernd",title:"private title"});assert.equal(create.status,201,await create.clone().text());const {session}=await create.json() as any;
  const bobGet=await h.call(bob,`/api/v1/chats/${session.id}`);assert.equal(bobGet.status,404);await bobGet.text();
  const bobList=await h.call(bob,"/api/v1/chats");assert.deepEqual((await bobList.json() as any).sessions,[]);
  const foreign=await h.call(alice,"/api/v1/chats","POST",{agentId:"anna"});assert.equal(foreign.status,403);await foreign.text();
  const denied=await h.call(viewer,"/api/v1/chats","POST",{agentId:"bernd"});assert.equal(denied.status,403);await denied.text();
  const stream=await h.call(alice,`/api/v1/chats/${session.id}/messages`,"POST",{text:"hello from HTTP"},{accept:"text/event-stream"});assert.equal(stream.status,200,await stream.clone().text());const wire=await stream.text();assert.ok(wire.includes("turn.started")&&wire.includes("turn.completed"),wire);
  const sequences=[...wire.matchAll(/id: [^\n]+:(\d+)\n/g)].map(m=>Number(m[1]));assert.deepEqual(sequences,[...sequences].sort((a,b)=>a-b));
  const fork=await h.call(alice,`/api/v1/chats/${session.id}/fork`,"POST",{});assert.equal(fork.status,201,await fork.clone().text());const forkId=(await fork.json() as any).session.id;
  const forkGet=await h.call(alice,`/api/v1/chats/${forkId}`);assert.equal((await forkGet.json() as any).messages.length,2);
  const earlyDelete=await h.call(alice,`/api/v1/chats/${session.id}`,"DELETE",{});assert.equal(earlyDelete.status,409);await earlyDelete.text();
  const archive=await h.call(alice,`/api/v1/chats/${session.id}/archive`,"POST",{});assert.equal(archive.status,200);await archive.text();
  const proof=await h.call(alice,`/api/v1/chats/${session.id}`,"DELETE",{});const nonce=(await proof.json() as any).confirmation.nonce;
  const steal=await h.call(bob,`/api/v1/chats/${session.id}`,"DELETE",{nonce});assert.equal(steal.status,404);await steal.text();
  const deleted=await h.call(alice,`/api/v1/chats/${session.id}`,"DELETE",{nonce});assert.equal(deleted.status,200);assert.equal((await deleted.json() as any).purged,true);
  const minted=await h.call(alice,"/api/v1/tokens","POST",{name:"read chat",scopes:["chat:read"]});assert.equal(minted.status,201,await minted.clone().text());const token=(await minted.json() as any).token;
  const read=await fetch(h.url+"/api/v1/chats",{headers:{authorization:`Bearer ${token}`}});assert.equal(read.status,200);await read.text();
  const write=await fetch(h.url+"/api/v1/chats",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({agentId:"bernd"})});assert.equal(write.status,403);await write.text();
});
test("incognito has no durable chat/transcript and concurrent idempotent create yields one chat",{timeout:30000},async t=>{
  const h=await setup(t),cookie=await h.login("alice");const key="fixture-create-once";
  const created=await Promise.all([h.call(cookie,"/api/v1/chats","POST",{agentId:"bernd"},{"idempotency-key":key}),h.call(cookie,"/api/v1/chats","POST",{agentId:"bernd"},{"idempotency-key":key})]);
  const ids=await Promise.all(created.map(async r=>{assert.equal(r.status,201);return (await r.json() as any).session.id;}));assert.equal(ids[0],ids[1]);
  const warm=await h.call(cookie,`/api/v1/chats/${ids[0]}/messages`,"POST",{text:"Prepare persistent baseline",wait:true});assert.equal(warm.status,200);await warm.text();
  const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):e.isFile()?[join(dir,e.name)]:[]);
  const before=walk(h.home).sort();
  const marker="redact-probe-incognito-alpha";
  const inc=await h.call(cookie,"/api/v1/chats","POST",{agentId:"bernd",memoryMode:"incognito",title:marker});assert.equal(inc.status,201);const id=(await inc.json() as any).session.id;
  const sent=await h.call(cookie,`/api/v1/chats/${id}/messages`,"POST",{text:marker,wait:true});assert.equal(sent.status,200,await sent.clone().text());const sentResult=await sent.json() as any;assert.equal(sentResult.state,"completed",JSON.stringify(sentResult));
  assert.deepEqual(walk(h.home).sort(),before,"incognito creates no durable files after the ordinary-chat baseline");
  for(const file of walk(h.home))assert.ok(!readFileSync(file).includes(Buffer.from(marker)),`incognito marker leaked into ${file}`);
});

test("real HTTP Operator sees direct-chat metadata only; Break-glass grants read access and immediately notifies target",{timeout:30000},async t=>{
 const h=await setup(t),alice=await h.login("alice"),ops=await h.login("ops"),admin=await h.login("admin");
 const create=await h.call(alice,"/api/v1/chats","POST",{agentId:"bernd",title:"confidential title"});const id=(await create.json() as any).session.id;
 const send=await h.call(alice,`/api/v1/chats/${id}/messages`,"POST",{text:"confidential transcript",wait:true});assert.equal(send.status,200);await send.text();
 const rpc=async(cookie:string,method:string,params:object)=>{const r=await h.call(cookie,"/rpc","POST",{jsonrpc:"2.0",id:1,method,params});assert.equal(r.status,200);return r.json() as Promise<any>;};
 const overview=await rpc(ops,"session.list",{allOwners:true});assert.ok(overview.result,JSON.stringify(overview));const row=overview.result.sessions.find((s:any)=>s.id===id);assert.ok(row);assert.equal(row.title,"");assert.ok(!JSON.stringify(row).includes("confidential"));
 const params={caller:{channel:"cli",accountId:"harness-api",userId:"admin"},sessionId:id,messages:10};
 const refused=await rpc(admin,"session.get",params);assert.equal(refused.error.data.error,"E_NOT_FOUND");
 const grant=await rpc(admin,"breakglass.request",{targetUserId:"alice",reason:"Investigate an explicit incident",windowMinutes:5});assert.ok(grant.result,JSON.stringify(grant));
 const notice=await rpc(alice,"breakglass.notices",{});assert.ok(notice.result.notices.some((n:any)=>n.holderUserId==="admin"),JSON.stringify(notice));
 const transcript=await rpc(admin,"session.get",params);assert.ok(transcript.result.messages.some((m:any)=>m.text==="confidential transcript"),JSON.stringify(transcript));
 const deniedWrite=await h.call(admin,`/api/v1/chats/${id}/archive`,"POST",{});assert.equal(deniedWrite.status,404);await deniedWrite.text();
});
test("real HTTP/core: break-glass has one registry — a REST grant lets the core read, a REST revoke ends it, an RPC grant is listed and revoked over REST, and the grant is audited and announced once",{timeout:30000},async t=>{
 const h=await setup(t),alice=await h.login("alice"),admin=await h.login("admin");
 const create=await h.call(alice,"/api/v1/chats","POST",{agentId:"bernd",title:"confidential title"});const id=(await create.json() as any).session.id;
 const send=await h.call(alice,`/api/v1/chats/${id}/messages`,"POST",{text:"confidential transcript",wait:true});assert.equal(send.status,200);await send.text();
 const rpc=async(cookie:string,method:string,params:object)=>{const r=await h.call(cookie,"/rpc","POST",{jsonrpc:"2.0",id:1,method,params});assert.equal(r.status,200);return r.json() as Promise<any>;};
 const params={caller:{channel:"cli",accountId:"harness-api",userId:"admin"},sessionId:id,messages:10};
 const readable=async()=>{const r=await rpc(admin,"session.get",params);return r.result?.messages?.some((m:any)=>m.text==="confidential transcript")===true;};
 const granted=()=>h.audit.events.filter(e=>e.action==="break-glass.granted");
 assert.equal(await readable(),false,"no grant: the core refuses");
 // REST grant -> the core's own read honours it, one audit line, one notice.
 const made=await h.call(admin,"/api/v1/breakglass","POST",{targetUserId:"alice",reason:"Investigate an explicit incident",ttlMinutes:5});assert.equal(made.status,201,await made.clone().text());const g=(await made.json() as any).grant;
 assert.equal(await readable(),true,"a REST grant lets the core read");
 assert.deepEqual(granted().map(e=>e.detail.grantId),[g.id]);
 const pulled=await h.call(alice,"/api/v1/me/notices");assert.equal(pulled.status,200);assert.deepEqual((await pulled.json() as any).notices.map((n:any)=>[n.grantId,n.holderUserId]),[[g.id,"admin"]]);
 assert.deepEqual((await rpc(alice,"breakglass.notices",{})).result.notices.map((n:any)=>n.grantId),[g.id],"the same notice over RPC");
 // REST revoke -> the core refuses again.
 const ended=await h.call(admin,"/api/v1/breakglass/revoke","POST",{grantId:g.id});assert.equal(ended.status,200,await ended.clone().text());await ended.text();
 assert.equal(await readable(),false,"a REST revoke takes the read away");
 // RPC grant -> listed over REST, revoked over REST.
 const viaRpc=await rpc(admin,"breakglass.request",{targetUserId:"alice",reason:"Investigate an explicit incident",windowMinutes:5});assert.ok(viaRpc.result,JSON.stringify(viaRpc));
 const listed=await h.call(admin,"/api/v1/breakglass");assert.equal(listed.status,200);assert.deepEqual((await listed.json() as any).grants.map((x:any)=>x.id),[viaRpc.result.id],"an RPC grant is visible over REST");
 assert.equal(await readable(),true);
 const endedRpc=await h.call(admin,"/api/v1/breakglass/revoke","POST",{grantId:viaRpc.result.id});assert.equal(endedRpc.status,200,"an RPC grant can be revoked over REST");await endedRpc.text();
 assert.equal(await readable(),false);
 // A grant the core refuses leaves no audit line and no notice.
 const before=granted().length,noticesBefore=(await rpc(alice,"breakglass.notices",{})).result.notices.length;
 const self=await h.call(admin,"/api/v1/breakglass","POST",{targetUserId:"admin",reason:"Investigate an explicit incident"});assert.equal(self.status,400);await self.text();
 assert.equal(granted().length,before);assert.equal((await rpc(alice,"breakglass.notices",{})).result.notices.length,noticesBefore);
});
test("real HTTP keyset pagination merges persistent and RAM chats, binds owner and filters, and reports truncation",{timeout:30000},async t=>{
 const h=await setup(t),alice=await h.login("alice"),bob=await h.login("bob"),ids:string[]=[];
 for(let n=0;n<7;n++){const r=await h.call(alice,"/api/v1/chats","POST",{agentId:"bernd",title:`page needle ${n}`,memoryMode:n%2?"incognito":"remember"});assert.equal(r.status,201);ids.push((await r.json() as any).session.id);}
 await (await h.call(alice,`/api/v1/chats/${ids[1]}`,"PATCH",{pinned:true})).text();
 await (await h.call(bob,"/api/v1/chats","POST",{agentId:"bernd",title:"other owner needle"})).text();
 const all:string[]=[];let cursor:string|null=null;let firstCursor="";
 do {const r=await h.call(alice,`/api/v1/chats?agent=bernd&q=needle&limit=2${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);assert.equal(r.status,200,await r.clone().text());const page=await r.json() as any;assert.ok(page.sessions.length<=2);all.push(...page.sessions.map((s:any)=>s.id));if(!firstCursor){firstCursor=page.nextCursor;assert.equal(page.sessions[0].id,ids[1]);assert.equal(page.truncated,true);}assert.equal(page.truncated,!!page.nextCursor);cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(new Set(all),new Set(ids));assert.equal(all.length,ids.length);
 for(const [cookie,path]of [[bob,`/api/v1/chats?agent=bernd&q=needle&cursor=${firstCursor}`],[alice,`/api/v1/chats?agent=bernd&q=different&cursor=${firstCursor}`],[alice,`/api/v1/chats?agent=bernd&q=needle&state=any&cursor=${firstCursor}`],[alice,"/api/v1/chats?cursor=malformed"],[alice,`/api/v1/chats?cursor=${firstCursor.slice(0,-2)}aa`]] as const){const r=await h.call(cookie,path);assert.equal(r.status,400);await r.text();}
});
test("real HTTP message before paging and canonical idempotence reject conflicting HTTP identity fields without effects",{timeout:30000},async t=>{
 const h=await setup(t),cookie=await h.login("alice"),key="canonical-key";
 const first=await h.call(cookie,"/api/v1/chats","POST",{agentId:"bernd",title:"Canonical"},{"idempotency-key":key});assert.equal(first.status,201);const id=(await first.json() as any).session.id;
 const second=await h.call(cookie,"/api/v1/chats","POST",{title:"Canonical",agentId:"bernd"},{"idempotency-key":key});assert.equal(second.status,201);assert.equal((await second.json() as any).session.id,id);
 for(const [path,body]of [["/api/v1/agents/bernd/chats",{agentId:"anna"}],[`/api/v1/chats/${id}/messages`,{text:"must not run",sessionId:"another"}],[`/api/v1/chats/${id}/messages`,{text:"must not run",idempotencyKey:"body-key"}],[`/api/v1/chats/${id}/messages`,{text:"must not run",_unknown:true}]] as const){const r=await h.call(cookie,path,"POST",body);assert.equal(r.status,400);await r.text();}
 for(let n=0;n<3;n++){const r=await h.call(cookie,`/api/v1/chats/${id}/messages`,"POST",{text:`turn ${n}`,wait:true});assert.equal(r.status,200);await r.text();}
 const before=await h.call(cookie,`/api/v1/chats/${id}/messages?before=5&limit=2`);assert.equal(before.status,200);assert.deepEqual((await before.json() as any).messages.map((m:any)=>m.seq),[3,4]);
 const earlier=await h.call(cookie,`/api/v1/chats/${id}/messages?before=3&limit=2`);assert.deepEqual((await earlier.json() as any).messages.map((m:any)=>m.seq),[1,2]);
 for(const value of ["0","-1","1.2","2e1","9007199254740992"]){const r=await h.call(cookie,`/api/v1/chats/${id}/messages?before=${value}`);assert.equal(r.status,400);await r.text();}
 const full=await h.call(cookie,`/api/v1/chats/${id}`);const result=await full.json() as any;assert.equal(result.session.turnCount,3);assert.equal(result.messages.length,6);
});
test("real HTTP SSE resume requires original key and selected-turn event, replays ordered suffix with no new turn",{timeout:30000},async t=>{
 const h=await setup(t),cookie=await h.login("alice"),r=await h.call(cookie,"/api/v1/chats","POST",{agentId:"bernd"}),id=(await r.json() as any).session.id,path=`/api/v1/chats/${id}/messages`,key="stream-once";
 const initial=await h.call(cookie,path,"POST",{text:"single turn"},{accept:"text/event-stream","idempotency-key":key});assert.equal(initial.status,200);const wire=await initial.text(),events=[...wire.matchAll(/id: ([^\n]+)\n/g)].map(m=>m[1]!);assert.ok(events.length>=2);
 const resumed=await h.call(cookie,path,"POST",{text:"single turn"},{accept:"text/event-stream","idempotency-key":key,"last-event-id":events[0]!});assert.equal(resumed.status,200);const suffix=await resumed.text();assert.deepEqual([...suffix.matchAll(/id: ([^\n]+)\n/g)].map(m=>m[1]),events.slice(1));
 for(const headers of [{"last-event-id":events[0]!},{"last-event-id":"wrong:1","idempotency-key":key},{"last-event-id":`${id}:9007199254740992`,"idempotency-key":key},{"last-event-id":`${id}:01`,"idempotency-key":key},{"last-event-id":`${id}:999999`,"idempotency-key":key},{"last-event-id":events[0]!,"idempotency-key":"different-key"}]){const denied=await h.call(cookie,path,"POST",{text:"single turn"},{accept:"text/event-stream",...headers});assert.ok([400,409].includes(denied.status),await denied.clone().text());await denied.text();}
 const read=await h.call(cookie,`/api/v1/chats/${id}`);assert.equal((await read.json() as any).session.turnCount,1);
 const newer=await h.call(cookie,path,"POST",{text:"second turn",wait:true},{"idempotency-key":"other-turn"});assert.equal(newer.status,200);await newer.text();
 const wrongTurn=await h.call(cookie,path,"POST",{text:"second turn",wait:true},{accept:"text/event-stream","idempotency-key":"other-turn","last-event-id":events[0]!});assert.equal(wrongTurn.status,400);await wrongTurn.text();
});
test("real HTTP maximum page reports more than 200 durable chats instead of losing store truncation",{timeout:30000},async t=>{
 const h=await setup(t),cookie=await h.login("alice"),link=createCoreLink(h.home);t.after(()=>link.close());
 for(let n=0;n<205;n++)await link.callAs!("chat.create",{agentId:"bernd",title:`bulk ${n}`},{kind:"person",userId:"alice",role:"member",agentRights:{bernd:"use"}},"core");
 const first=await h.call(cookie,"/api/v1/chats?limit=200"),page=await first.json() as any;assert.equal(first.status,200);assert.equal(page.sessions.length,200);assert.equal(page.truncated,true);assert.ok(page.nextCursor);
 const second=await h.call(cookie,`/api/v1/chats?limit=200&cursor=${encodeURIComponent(page.nextCursor)}`),tail=await second.json() as any;assert.equal(tail.sessions.length,5);assert.equal(tail.truncated,false);assert.equal(tail.nextCursor,null);assert.equal(new Set([...page.sessions,...tail.sessions].map(s=>s.id)).size,205);
});
test("real HTTP SSE submit requires both chat read and write authorization before starting a turn",{timeout:30000},async t=>{
 const h=await setup(t),cookie=await h.login("alice"),created=await h.call(cookie,"/api/v1/chats","POST",{agentId:"bernd"}),id=(await created.json() as any).session.id;
 for(const scope of ["chat:read","chat:write"]){const minted=await h.call(cookie,"/api/v1/tokens","POST",{name:scope,scopes:[scope]});assert.equal(minted.status,201);const token=(await minted.json() as any).token;const denied=await fetch(h.url+`/api/v1/chats/${id}/messages`,{method:"POST",headers:{authorization:`Bearer ${token}`,accept:"text/event-stream","content-type":"application/json","idempotency-key":scope},body:JSON.stringify({text:"must not start"})});assert.equal(denied.status,403,await denied.clone().text());await denied.text();}
 const read=await h.call(cookie,`/api/v1/chats/${id}`);assert.equal((await read.json() as any).session.turnCount,0);
});
test("real HTTP message history opens latest bounded page and pages backward; chat.get preserves forward order",{timeout:30000},async t=>{
 const h=await setup(t),cookie=await h.login("alice"),created=await h.call(cookie,"/api/v1/chats","POST",{agentId:"bernd"}),id=(await created.json() as any).session.id;
 for(let n=0;n<3;n++){const r=await h.call(cookie,`/api/v1/chats/${id}/messages`,"POST",{text:`history turn ${n}`,wait:true});assert.equal(r.status,200);await r.text();}
 const page=async(query:string)=>{const r=await h.call(cookie,`/api/v1/chats/${id}/messages?limit=2${query}`);assert.equal(r.status,200);return(await r.json() as any).messages.map((m:any)=>m.seq);};
 assert.deepEqual(await page(""),[5,6]);assert.deepEqual(await page("&before=5"),[3,4]);assert.deepEqual(await page("&before=3"),[1,2]);assert.deepEqual(await page("&before=1"),[]);
 const legacy=await h.call(cookie,`/api/v1/chats/${id}?limit=2`);assert.deepEqual((await legacy.json() as any).messages.map((m:any)=>m.seq),[1,2]);
});
