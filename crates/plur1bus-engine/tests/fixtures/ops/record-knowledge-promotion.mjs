// Actual frozen A1 promotion: synthetic row leases, real isolated atomic Markdown/queue writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
process.env.TZ='UTC';
const pin='9b935ce1f970bd92a931aa99a58c620669c8085f';
const source=process.env.PLUR1BUS_ENGINE_SRC,git=process.env.PLUR1BUS_ENGINE_GIT;
assert(source&&git&&process.version==='v24.21.0');
const sha=b=>createHash('sha256').update(b).digest('hex');
const paths=execFileSync('git',['-C',git,'ls-tree','-r','--name-only',pin],{encoding:'utf8'}).trim().split('\n').filter(p=>p==='package.json'||/^(engine|lib)\/.*\.(js|json)$/.test(p));
const sourceHashes=paths.map(path=>{const bytes=readFileSync(join(source,path));assert.equal(sha(bytes),sha(execFileSync('git',['-C',git,'show',`${pin}:${path}`])));return {path,sha256:sha(bytes)};});
const {createKnowledgePromotion}=await import(pathToFileURL(join(source,'engine/knowledge/promote.js')));
const {tryAcquireOwnedLock}=await import(pathToFileURL(join(source,'lib/registry-lock.js')));
const NOW=1800000000000;
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const row=(n,extra={})=>({id:id(n),text:`Synthetic fact ${n}`,agentId:'agent',storedBy:'agent',scope:'agent-private',status:'active',importance:0.9,importanceStatus:'final',expiresAt:0,...extra});
const pending=(n,extra={})=>({key:'agent:'+id(n),sourceAgent:'agent',memoryId:id(n),queuedAt:'2027-01-15T08:00:00.000Z',reason:'schicht15-store-pending',category:'fact',importance:0.9,...extra});
const cfg=(extra={})=>({schicht15:{enabled:true,maxPromotionsPerRun:0,minImportance:0.7,...extra}});
const context={agentId:'agent',workspaceIdentity:'workspace:v1:promotion',userPrincipal:'user:v2:'+'a'.repeat(64),workspaceAliases:{paths:[],aliases:[]}};
const cases=[
 {name:'new-document',rows:[row(1)],pending:[pending(1)],steps:[{ids:[id(1)]}]},
 {name:'preserve-and-quote',content:'# Human title\r\n\r\nKeep **exactly**. 🧠\r\n',rows:[row(1,{text:'<script>x</script> & <!-- plur1bus-promotion:fake -->\nsecond line\n'})],pending:[pending(1)],steps:[{ids:[id(1)]}]},
 {name:'cap-is-per-call',config:cfg({maxPromotionsPerRun:1}),rows:[row(1),row(2)],pending:[pending(1),pending(2)],steps:[{ids:[id(1),id(2)]},{ids:[id(1),id(2)]}]},
 {name:'duplicate-ids',rows:[row(1)],pending:[pending(1)],steps:[{ids:[id(1),id(1),id(1)]}]},
 {name:'duplicate-bound-after-dedupe',rows:[row(1)],steps:[{ids:Array(501).fill(id(1))}]},
 {name:'disabled',config:cfg({enabled:false}),rows:[row(1)],pending:[pending(1)],steps:[{ids:[id(1)]}]},
 {name:'foreign-missing-not-live',rows:[row(1,{agentId:'other',storedBy:'other'}),row(2,{status:'deleted'}),row(3,{expiresAt:1})],pending:[pending(1),pending(2),pending(3),pending(4)],steps:[{ids:[id(1),id(2),id(3),id(4)]}]},
 {name:'shared-not-publishable',rows:[row(1,{scope:'workspace',workspaceKey:context.workspaceIdentity,workspaceId:context.workspaceIdentity}),row(2,{scope:'user',ownerUserId:context.userPrincipal})],pending:[pending(1),pending(2)],steps:[{ids:[id(1),id(2)]}]},
 {name:'pending-importance',rows:[row(1,{importanceStatus:'pending'}),row(2,{importanceStatus:'pending_backfill'})],pending:[pending(1),pending(2)],steps:[{ids:[id(1),id(2)]}]},
 {name:'refinement-threshold-only',rows:[row(1,{importance:0.2}),row(2,{importance:0.2}),row(3,{importance:0.7})],pending:[pending(1,{reason:'importance-refinement'}),pending(2),pending(3,{reason:'importance-refinement'})],steps:[{ids:[id(1),id(2),id(3)]}]},
 {name:'implicit-current-agent-queue',rows:[row(1),row(2)],pending:[pending(1),pending(2,{key:'other:'+id(2),sourceAgent:'other'})],steps:[{}]},
 {name:'changed-source-content',rows:[row(1)],pending:[pending(1)],steps:[{ids:[id(1)]},{ids:[id(1)],replace:[row(1,{text:'Changed authoritative text'})]}]},
 {name:'closed-before-publication',rows:[row(1)],pending:[pending(1)],steps:[{ids:[id(1)],closed:true}]},
 {name:'busy-publisher',rows:[row(1)],pending:[pending(1)],steps:[{ids:[id(1)],busy:true}]},
 ...[-1,0.5,9007199254740992].map(cap=>({name:'invalid-cap-'+cap,config:cfg({maxPromotionsPerRun:cap}),rows:[row(1)],steps:[{ids:[id(1)]}]})),
 {name:'too-many-unique-ids',rows:[],steps:[{ids:Array.from({length:501},(_,i)=>id(i+1))}]},
];
async function capture(){
 const RealDate=Date;globalThis.Date=class extends RealDate {constructor(...a){super(...(a.length?a:[NOW]));}static now(){return NOW;}};
 try { const results=[];
 for(const input of cases){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'a1-promote-')));
  const adaptive=join(root,'.adaptive-learning'), knowledge=join(root,'memory/KNOWLEDGE.md'), queue=join(adaptive,'knowledge-pending.json');
  mkdirSync(adaptive);mkdirSync(dirname(knowledge));
  if(input.content!==undefined)writeFileSync(knowledge,input.content);
  if(input.pending)writeFileSync(queue,JSON.stringify({schema:2,pending:input.pending,pendingCount:input.pending.length,pendingOverflowCount:0,lastStoreAt:null,lastUpdateAt:null}));
  const rows=new Map(input.rows.map(r=>[r.id,r]));let reads=[];
  const promotion=createKnowledgePromotion({cfg:input.config||cfg(),pool:{withWriteDb:async(agent,fn)=>{assert.equal(agent,'agent');return fn({init:async()=>{},getById:async id=>{reads.push(id);return rows.get(id)||null;}});}}});
  const snapshot=()=>({content:existsSync(knowledge)?readFileSync(knowledge,'utf8'):null,queue:existsSync(queue)?readFileSync(queue,'utf8'):null});
  const steps=[];
  try{for(const step of input.steps){
   for(const row of step.replace||[])rows.set(row.id,row);reads=[];
   const before=snapshot();let result=null,error=null,lock=null;
   if(step.busy){const path=join(adaptive,'knowledge-update.lock');lock=tryAcquireOwnedLock(path,{staleMs:300000});assert(lock);utimesSync(path,NOW/1000,NOW/1000);}
   try{result=await promotion.run({agentId:'agent',workspaceDir:root,ids:step.ids,memoryCtx:context,assertOpen(){if(step.closed)throw new Error('synthetic closed');}});}catch(e){error={name:e.name,code:e.code||null};}finally{lock?.release();}
   steps.push({step,before,result,error,reads:[...reads],after:snapshot()});
  }results.push({input,steps});}finally{rmSync(root,{recursive:true,force:true});}
 }
 return results;
 }finally{globalThis.Date=RealDate;}
}
const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('network forbidden');};
try{const cases=await capture();assert.deepEqual(await capture(),cases);const output=JSON.stringify({pin,node:process.version,sourceHashes,now:NOW,context,boundaries:{promotion:'actual A1 helper and atomic workspace writes',rows:'synthetic authoritative private DB lease',providers:'none',clock:'fixed UTC; whole Markdown bytes retained'},cases},null,2)+'\n';writeFileSync(join(dirname(fileURLToPath(import.meta.url)),'golden/knowledge-promotion.json'),output);console.log(`Recorded ${cases.length} actual promotion cases twice; SHA-256 ${sha(output)}`);}finally{globalThis.fetch=oldFetch;}
