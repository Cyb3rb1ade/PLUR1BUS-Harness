import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../../src/session/store.ts";
test("chat keyset queries filter hidden agents and other owners before bounded LIMIT; ties use the same ID order",t=>{
 const store=new SessionStore({path:":memory:",clock:()=>1000});t.after(()=>store.close());
 for(let n=0;n<210;n++)store.createSession({kind:"direct",agentId:"hidden",owner:"user:v1:alice",title:"match"});
 for(let n=0;n<7;n++)store.createSession({kind:"direct",agentId:"bernd",owner:"user:v1:alice",title:"match"});
 store.createSession({kind:"direct",agentId:"bernd",owner:"user:v1:bob",title:"match"});
 const base={owner:"user:v1:alice",allowedAgents:["bernd"],search:"match",limit:2};const found:string[]=[];let after:{pinned:boolean;updatedAt:number;id:string}|undefined;
 do{const page=store.listChatSessions({...base,...(after?{after}:{})});assert.ok(page.sessions.length<=2);assert.ok(page.sessions.every(s=>s.owner===base.owner&&s.agentId==="bernd"));found.push(...page.sessions.map(s=>s.id));const last=page.sessions.at(-1);after=page.truncated&&last?{pinned:last.pinned,updatedAt:last.updatedAt,id:last.id}:undefined;}while(after);
 assert.equal(found.length,7);assert.equal(new Set(found).size,7);assert.deepEqual(found,[...found].sort());
 assert.deepEqual(store.listChatSessions({...base,allowedAgents:[]}),{sessions:[],truncated:false});
});
test("beforeSeq selects nearest earlier messages while preserving chronological wire order",t=>{
 const store=new SessionStore({path:":memory:"});t.after(()=>store.close());const session=store.createSession({kind:"direct",agentId:"bernd",owner:"user:v1:alice"});
 for(let n=0;n<4;n++){const {turn}=store.beginTurn(session.id,`user ${n}`,1);store.completeTurn(turn.id,{text:`assistant ${n}`,tokens:1});}
 assert.deepEqual(store.listMessages(session.id,{beforeSeq:7,limit:3}).map(m=>m.seq),[4,5,6]);assert.deepEqual(store.listMessages(session.id,{beforeSeq:1,limit:3}),[]);
});
