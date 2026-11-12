// Actual C3 rebind/unbind orchestration on Lance; deterministic clock and synthetic failures.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,'v24.21.0');
const source=JSON.parse(readFileSync(new URL('./rebind-sources.json',import.meta.url),'utf8'));
const files=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.js'))files.push(f);}}
walk(path.join(root,'engine'));walk(path.join(root,'lib'));const hash=createHash('sha256');
for(const f of files.sort()){hash.update(`${path.relative(root,f)}\0`);hash.update(readFileSync(f));hash.update('\0');}assert.equal(hash.digest('hex'),source.treeSha256);
const load=f=>import(pathToFileURL(path.join(root,f)));
const {createMemoryRebind}=await load('engine/memory-ops/rebind.js');
const {createMemoryOpsContext}=await load('engine/memory-ops/context.js');
const {MemoryDB}=await load('engine/store/memory-db.js');
const {channelIdentityUserPrincipal,harnessUserPrincipal}=await load('lib/memory-request-context.js');
const {contentFingerprint}=await load('lib/tombstone.js');
const now=1800000000000;const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
const p={agentId:'agent',workspace:'workspace:v1:fixture',channel:'',accountId:'',chat:{id:'',kind:'direct'},trust:'inferred'},a={origin:'system',background:false};
const id='33333333-3333-4333-8333-333333333333';const fromIdentity={channel:'telegram',identityKey:'synthetic-channel-user'};const toUser='synthetic-harness-user';
const from=channelIdentityUserPrincipal('telegram','synthetic-channel-user','default'),to=harnessUserPrincipal(toUser);
const defs=[
{name:'default-preview'}, {name:'apply-repeat',apply:true,repeat:true}, {name:'empty-apply',apply:true,empty:true}, {name:'missing-store-preview',missing:true},
{name:'filtered-scopes-owners-status',apply:true,extras:true}, {name:'trim-identities',apply:true,request:{fromIdentity:{channel:' telegram ',identityKey:' synthetic-channel-user ',accountId:' default '},toUser:' synthetic-harness-user '}},
{name:'channel-case-is-significant',apply:true,request:{fromIdentity:{...fromIdentity,channel:'Telegram'}}},
{name:'invalid-agent',apply:true,request:{agentId:'other'}},{name:'invalid-empty-target',apply:true,request:{toUser:'   '}},
{name:'invalid-long-identity',apply:true,request:{fromIdentity:{...fromIdentity,identityKey:'x'.repeat(129)}}},
{name:'invalid-long-account',apply:true,request:{fromIdentity:{...fromIdentity,accountId:'x'.repeat(129)}}},
{name:'user-origin-denied',apply:true,context:{origin:'user',background:false}},{name:'background-denied',apply:true,context:{origin:'system',background:true}},
{name:'patch-failure-resumes-intent',apply:true,patchFailure:true,repeat:true},
{name:'unbind-repeat',apply:true,unbind:true,repeatUnbind:true},{name:'unbind-preview',apply:true,unbind:true,dryUnbind:true},
{name:'unbind-legacy-string-time',apply:true,unbind:true,ledgerTimestamp:String(now-1000)},
{name:'unbind-legacy-null-time',apply:true,unbind:true,ledgerTimestamp:null},
{name:'unbind-edited',apply:true,unbind:true,change:{updatedAt:now+1}},
{name:'unbind-other-owner',apply:true,unbind:true,change:{ownerUserId:harnessUserPrincipal('other')}},
{name:'unbind-already-source',apply:true,unbind:true,change:{ownerUserId:from}},
{name:'unbind-missing-card',apply:true,unbind:true,delete:true},
{name:'unbind-other-agent',apply:true,unbind:true,unbindPrincipal:{...p,agentId:'other'}},
{name:'unbind-deleted',apply:true,unbind:true,change:{status:'deleted'}},
{name:'unbind-scope-moved',apply:true,unbind:true,change:{scope:'workspace'}},
{name:'rebind-restored-forgotten',apply:true,tombstoneBefore:true},
{name:'unbind-restored-forgotten',apply:true,unbind:true,tombstoneAfter:true},
{name:'claim-conflict-no-header',apply:true,claimOther:true},
{name:'header-claim-disagree',apply:true,headerClaimDisagree:true},
];
async function record(){const cases=[];for(const def of defs){const work=mkdtempSync(path.join(tmpdir(),'rx3-rebind-'));const baseDbPath=path.join(work,'store');const workspace=path.join(work,'workspace');mkdirSync(workspace);const db=new MemoryDB(path.join(baseDbPath,'agent'),4);await db.init();try{
const row={id,text:'Synthetic user-owned memory for migration.',summary:'Synthetic user memory',vector:[1,0,0,0],createdAt:now-1000,updatedAt:now-1000,agentId:'agent',storedBy:'agent',scope:'user',ownerUserId:from,status:'active',epistemicStatus:'observed',origin:'note',category:'fact',importance:0.5};
if(!def.empty&&!def.missing)await db.store(row);
if(def.extras)for(const [i,patch]of [{scope:'agent-private'},{scope:'workspace'},{ownerUserId:to},{status:'deleted'},{status:'superseded'},{status:''},{memoryKind:'reminder'}].entries())await db.store({...row,id:`44444444-4444-4444-8444-${String(i+1).padStart(12,'0')}`,...patch});
const opsContext=createMemoryOpsContext({host:{stateDir:path.join(work,'state'),workspaceDir:async()=>workspace}});let reads=0,writes=0;
const pool={withAuthoritativeReadDb:async(_agent,fn)=>{reads++;return fn(def.missing?null:db)},withWriteDb:async(_agent,fn)=>{writes++;return fn(db)}};
const ops=createMemoryRebind({opsContext,pool,baseDbPath,clock:()=>now});
const fixed='11111111-1111-4111-8111-111111111111';
if(def.claimOther||def.headerClaimDisagree)await ops.ledger.withLock({exclusive:true},async()=>{ops.ledger.writeClaim(from,harnessUserPrincipal('other'));if(def.headerClaimDisagree)ops.ledger.writeHeader(fixed,{agentId:'agent',fromOwner:from,toOwner:to,createdAt:now});});
const tombstone={schemaVersion:1,tombstoneId:'fixture-tombstone',memoryId:id,canonicalOriginId:id,agentId:'agent',scope:'user',workspaceId:'',workspaceKey:'',ownerUserId:from,storedBy:'agent',deletedAt:new Date(now).toISOString(),actor:'principal:agent',actorType:'human',reason:'MemoryOps.forget',sourceOp:'forget',archiveRef:'fixture-archive',previousVersion:'',contentFingerprint:contentFingerprint(row.text),sourceFingerprint:'',refs:{},status:'committed'};
function forget(){mkdirSync(path.join(work,'_tombstones'),{recursive:true});writeFileSync(path.join(work,'_tombstones/agent.jsonl'),JSON.stringify(tombstone)+'\n');}
if(def.tombstoneBefore)forget();
const rows=async()=>JSON.parse(JSON.stringify(await db.table.query().toArray(),(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v)).filter(r=>r.id!=='__schema__').sort((a,b)=>a.id.localeCompare(b.id));
const initialRows=await rows();let fail=!!def.patchFailure;const update=db.update.bind(db);db.update=async(...args)=>{if(fail){fail=false;throw new Error('synthetic owner-patch failure')}return update(...args)};
function files(){const out={};const root=path.join(baseDbPath,'_rebinds');function scan(dir){if(!existsSync(dir))return;for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())scan(f);else if(e.name!=='.lock')out[path.relative(root,f)]=readFileSync(f,'utf8');}}scan(root);return out;}
const initialFiles=files();const request={agentId:'agent',fromIdentity,toUser,...(def.apply?{dryRun:false}:{}),...def.request};const results=[];
for(let i=0;i<(def.repeat?2:1);i++){try{results.push({value:await ops.rebind(request,p,def.context??a)});}catch(e){assert.equal(typeof e.code,'string');results.push({error:e.code});}}
const beforeUnbindRows=await rows();const unbindResults=[];
if(def.unbind){if(Object.hasOwn(def,'ledgerTimestamp')){const rid=ops.ledger.listApplied()[0].rebindId;const file=path.join(baseDbPath,'_rebinds',rid+'.jsonl');const lines=readFileSync(file,'utf8').trimEnd().split('\n').map(JSON.parse);for(const line of lines)if(line.kind==='card')line.fromUpdatedAt=def.ledgerTimestamp;writeFileSync(file,lines.map(JSON.stringify).join('\n')+'\n');}if(def.change)await update(id,def.change);if(def.delete)await db.delete(id);if(def.tombstoneAfter)forget();const rebindId=ops.ledger.listApplied()[0]?.rebindId;assert.ok(rebindId);for(let i=0;i<(def.repeatUnbind?2:1);i++){try{unbindResults.push({value:await ops.unbind({rebindId:rebindId.toUpperCase(),...(def.dryUnbind?{dryRun:true}:{})},def.unbindPrincipal??p,a)});}catch(e){assert.equal(typeof e.code,'string');unbindResults.push({error:e.code});}}}
const finalFiles=files();const ids=Object.keys(finalFiles).filter(n=>n.endsWith('.jsonl')).map(n=>n.slice(0,-6)).filter(n=>n!==fixed);const normalize=value=>{let s=JSON.stringify(value);for(const [i,rid]of ids.entries())s=s.replaceAll(rid,`<rebind-${i+1}>`).replaceAll(rid.toUpperCase(),`<rebind-${i+1}>`);const output=JSON.parse(s);output.files=Object.fromEntries(Object.entries(output.files).sort(([a],[b])=>a.localeCompare(b)));return output};
cases.push(normalize({...def,request,initialRows,initialFiles,tombstone,results,beforeUnbindRows,unbindResults,rows:await rows(),files:finalFiles,reads,writes}));
}finally{await db.shutdown();rmSync(work,{recursive:true,force:true});}}return cases;}
const cases=await record();const repeated=await record();for(let i=0;i<cases.length;i++)assert.equal(JSON.stringify(repeated[i])===JSON.stringify(cases[i]),true,`unstable case ${cases[i].name}`);
writeFileSync(new URL('./golden/rebind.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},now,principal:p,agent:a,id,from,to,cases},null,2)+'\n');console.log(`Recorded ${cases.length} actual Node/Lance rebind cases twice`);
