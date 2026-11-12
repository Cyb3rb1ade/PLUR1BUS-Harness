// Exercise the unmodified C2 durable state store. Each case owns a fresh temporary root.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";import path from "node:path";import {pathToFileURL} from "node:url";
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,"v24.21.0");
const source=JSON.parse(readFileSync(new URL("./reembedding-sources.json",import.meta.url),"utf8"));const paths=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith(".js"))paths.push(p);}}
walk(path.join(root,"engine"));walk(path.join(root,"lib"));const hash=createHash("sha256");for(const p of paths.sort()){hash.update(`${path.relative(root,p)}\0`);hash.update(readFileSync(p));hash.update("\0");}assert.equal(hash.digest("hex"),source.treeSha256);
const {createMigrationStateStore}=await import(pathToFileURL(path.join(root,"lib/reembedding/state-store.js")));
const {createMigrationConfirmation}=await import(pathToFileURL(path.join(root,"lib/reembedding/confirmation.js")));
const digest=`sha256:${"a".repeat(64)}`;
const confirmation=()=>createMigrationConfirmation({planDigest:digest,expiresAt:5000,randomBytes:()=>Buffer.alloc(32,9)}).persisted;
const record=(id="migration-a",state="planned")=>({id,state,planDigest:digest,confirmation:confirmation(),source:{generation:"legacy",opaque:"preserved"},target:{generation:"generation-target"},revision:1,createdAt:"1970-01-01T00:00:01.000Z",updatedAt:"1970-01-01T00:00:01.000Z"});
const state=(records=[record()],revision=1)=>({schemaVersion:1,revision,migrations:Object.fromEntries(records.map(r=>[r.id,r]))});
const create=(id="migration-a")=>({op:"create",input:{id,state:"planned",planDigest:digest,confirmation:confirmation()}});
const update=(patch={},revision=1)=>({op:"update",id:"migration-a",options:{expectedRevision:revision,expectedState:"planned",patch}});
const states=["planned","confirmed","running","validating","ready_to_switch","switching","completed","failed","rollback_planned","rolling_back","rolled_back"];
const cases=[
 {name:"empty-reads",ops:[{op:"get",id:"absent"},{op:"list"}]},
 {name:"create-get-list",ops:[create(),{op:"get",id:"migration-a"},{op:"list"}]},
 {name:"duplicate-id",initial:state(),ops:[create()]},
 {name:"active-conflict",initial:state(),ops:[create("migration-b")]},
 {name:"stale-revision",initial:state(),ops:[update({cursor:{offset:6}},2)]},
 {name:"wrong-expected-state",initial:state(),ops:[{op:"update",id:"migration-a",options:{expectedRevision:1,expectedState:"running",patch:{}}}]},
 {name:"update-cursor-receipts",initial:state(),ops:[update({cursor:{tableIndex:1,offset:6},receipts:[{rows:6}]}),update({policyRevision:"fresh-policy"},2)]},
 {name:"unknown-record-field",ops:[{op:"create",input:{...create().input,extra:true}}]},
 {name:"create-must-be-planned",ops:[{op:"create",input:{...create().input,state:"running"}}]},
 {name:"bad-id",ops:[{op:"get",id:"../outside"},{op:"create",input:{...create().input,id:"../outside"}}]},
 {name:"confirmation-other-plan",initial:state(),ops:[update({confirmation:{...confirmation(),planDigest:`sha256:${"b".repeat(64)}`}})]},
 {name:"confirmation-extra",initial:state(),ops:[update({confirmation:{...confirmation(),extra:true}})]},
 {name:"opaque-utf16",initial:state([{...record(),source:{text:String.fromCharCode(0xd800),number:1e-7}}]),ops:[update({cursor:{offset:2}}),{op:"get",id:"migration-a"}]},
 {name:"invalid-json",raw:"{broken synthetic state",ops:[{op:"list"},create()]},
 {name:"unknown-state-field",initial:{...state(),extra:true},ops:[{op:"list"},create()]},
 {name:"negative-global-revision",initial:state(undefined,-1),ops:[{op:"list"}]},
 {name:"max-global-revision",initial:state([],Number.MAX_SAFE_INTEGER),ops:[create()],rustException:"revision-overflow"},
 {name:"max-record-revision",initial:state([{...record(),revision:Number.MAX_SAFE_INTEGER}]),ops:[update({},Number.MAX_SAFE_INTEGER)],rustException:"revision-overflow"},
 {name:"numeric-and-case-id-list-order",initial:state([record("10","completed"),record("2","completed"),record("Agent","completed"),record("agent","completed")]),ops:[{op:"list"}]},
 {name:"epoch-timestamps",initial:state([{...record(),createdAt:"1970-01-01T00:00:00.000Z",updatedAt:"1970-01-01T00:00:00.000Z"}]),ops:[{op:"get",id:"migration-a"}]},
];
for(const key of ["id","state","revision","createdAt","updatedAt","planDigest","extra"])cases.push({name:`forbidden-patch-${key}`,initial:state(),ops:[update({[key]:"synthetic"})]});
for(const key of ["apiKey","TOKEN","resolvedSecret","secretValue","credentialValue"])cases.push({name:`nested-forbidden-${key}`,initial:state(),ops:[update({target:{nested:[{[key]:"synthetic-private-value"}]}})]});
for(const active of states)cases.push({name:`expiry-retirement-${active}`,initial:state([record("migration-a",active)]),ops:[{...create("migration-b"),now:6000},{op:"list",now:6000}]});
for(const from of states)for(const to of states)cases.push({name:`transition-${from}-${to}`,initial:state([record("migration-a",from)]),ops:[{op:"transition",id:"migration-a",from,to,options:{expectedRevision:1,patch:{cursor:{offset:6}}}}]});
async function run(){const out=[];for(const c of cases){const work=mkdtempSync(path.join(tmpdir(),"rx5-state-"));const file=path.join(work,"control/reembedding-state.json");let now=2000;try{const store=createMigrationStateStore({stateRoot:work,now:()=>now});if(c.raw!==undefined)writeFileSync(file,c.raw);else if(c.initial)writeFileSync(file,JSON.stringify(c.initial));const results=[];for(const op of c.ops){now=op.now??2000;let result;try{let value;if(op.op==="create")value=await store.create(op.input);else if(op.op==="update")value=await store.update(op.id,op.options);else if(op.op==="transition")value=await store.transition(op.id,op.from,op.to,op.options);else if(op.op==="get")value=store.get(op.id);else value=store.list();result={value};}catch(e){result={error:e.message,code:e.code??null};}results.push({...result,file:existsSync(file)?readFileSync(file,"utf8"):null});}out.push({...c,results});}finally{rmSync(work,{recursive:true,force:true});}}return out;}
const recorded=await run();assert.deepEqual(await run(),recorded);
writeFileSync(new URL("./golden/reembedding-state.json",import.meta.url),JSON.stringify({recordedFrom:{engine:"node",source,node:process.version},cases:recorded},null,2)+"\n");
console.log(`Recorded ${recorded.length} actual Node state cases twice, including all 121 state pairs`);
