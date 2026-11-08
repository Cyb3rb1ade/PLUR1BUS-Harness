// Actual C3 rebind sidecars: repair, identity claims, first-card and last-header semantics.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,'v24.21.0');
const source=JSON.parse(readFileSync(new URL('./rebind-sources.json',import.meta.url),'utf8'));
const files=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.js'))files.push(f);}}
walk(path.join(root,'engine'));walk(path.join(root,'lib'));const hash=createHash('sha256');for(const f of files.sort()){hash.update(`${path.relative(root,f)}\0`);hash.update(readFileSync(f));hash.update('\0');}assert.equal(hash.digest('hex'),source.treeSha256);
const {createRebindLedger,identityClaimFileName}=await import(pathToFileURL(path.join(root,'engine/memory-ops/rebind-ledger.js')));
const id='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const from='user:v1:'+createHash('sha256').update('synthetic-from').digest('hex'),to='user:v2:'+createHash('sha256').update('synthetic-to').digest('hex');const now=1800000000000;
const header={v:1,kind:'header',rebindId:id,agentId:'agent',fromOwner:from,toOwner:to,status:'applied',createdAt:now};
const card={v:1,kind:'card',rebindId:id,cardId:'33333333-3333-4333-8333-333333333333',fromOwner:from,toOwner:to,fromUpdatedAt:10};
const h={op:'header',id,agent:'agent'},c={op:'card',id,card:card.cardId,updated:10},r={op:'reverse',id};
const defs=[
 {name:'read-missing',ops:[]},
 {name:'header-card-reverse',ops:[{op:'claim'},h,c,c,r,{op:'release'}]},
 {name:'claim-same-target',ops:[{op:'claim'},{op:'claim'}]},
 {name:'claim-other-target',ops:[{op:'claim'},{op:'claim',to:from}]},
 {name:'header-conflict',ops:[h,h]},
 {name:'first-card-wins',initial:[header,card,{...card,fromUpdatedAt:999,opaque:'legacy\ud800'}].map(JSON.stringify).join('\n')+'\n',ops:[]},
 {name:'last-header-resets-reversed',initial:[header,{v:1,kind:'reversed',rebindId:id,reversedAt:now},{...header,opaque:'legacy\ud800'}].map(JSON.stringify).join('\n')+'\n',ops:[]},
 {name:'reversed-header',initial:JSON.stringify({...header,status:'reversed'})+'\n',ops:[]},
 {name:'foreign-malformed-lines',initial:['{bad',JSON.stringify({...header,v:2}),JSON.stringify(header),JSON.stringify({...card,cardId:7}),JSON.stringify(card)].join('\n')+'\n',ops:[]},
 {name:'torn-tail-repaired',initial:JSON.stringify(header)+'\n'+JSON.stringify(card).slice(0,80),ops:[c]},
 {name:'valid-tail-without-newline-is-dropped-on-append',initial:JSON.stringify(header)+'\n'+JSON.stringify(card),ops:[r]},
 {name:'no-complete-line-quarantined',initial:'{torn',ops:[c]},
 {name:'valid-no-newline-quarantined',initial:JSON.stringify(header),ops:[c]},
 {name:'global-claim-retained-by-other-agent',ops:[{op:'claim'},h,{op:'header',id:second,agent:'other'},r,{op:'release'}]},
 {name:'last-agent-releases-claim',ops:[{op:'claim'},h,{op:'header',id:second,agent:'other'},r,{op:'reverse',id:second},{op:'release'}]},
 {name:'invalid-claim-json',initialClaim:'{bad',ops:[{op:'claim'}]},
];
async function record(){const cases=[];for(const def of defs){const work=mkdtempSync(path.join(tmpdir(),'rx3-rebind-ledger-'));const baseDbPath=path.join(work,'store');const rebinds=path.join(baseDbPath,'_rebinds');
try{
 if(def.initial!==undefined){mkdirSync(rebinds,{recursive:true});writeFileSync(path.join(rebinds,id+'.jsonl'),def.initial);}
 if(def.initialClaim!==undefined){mkdirSync(path.join(rebinds,'by-identity'),{recursive:true});writeFileSync(path.join(rebinds,'by-identity',identityClaimFileName(from)),def.initialClaim);}
 const ledger=createRebindLedger({baseDbPath,clock:()=>now});const results=[];
 if(def.ops.length)await ledger.withLock({exclusive:true},async()=>{for(const op of def.ops){try{switch(op.op){
 case 'claim':ledger.writeClaim(from,op.to??to);break;
 case 'header':ledger.writeHeader(op.id,{agentId:op.agent,fromOwner:from,toOwner:to,createdAt:now});break;
 case 'card':ledger.appendCard(op.id,{cardId:op.card,fromOwner:from,toOwner:to,fromUpdatedAt:op.updated});break;
 case 'reverse':ledger.appendReversed(op.id,now);break;
 case 'release':ledger.releaseClaimIfFree(from);break;
 }results.push({ok:true});}catch(e){assert.equal(typeof e.code,'string');results.push({error:e.code});}}});
 const normalize=r=>({header:r.header,cards:r.cards,reversed:r.reversed});const loaded=normalize(ledger.load(id));const applied=ledger.listApplied().map(r=>({id:r.rebindId,...normalize(r)})).sort((a,b)=>a.id.localeCompare(b.id));
 let claim;try{claim={value:ledger.readClaim(from)}}catch(e){claim={error:e.code}}
 const disk={};function snapshot(dir){if(!existsSync(dir))return;for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())snapshot(p);else disk[path.relative(rebinds,p)]=readFileSync(p,'utf8');}}snapshot(rebinds);
 cases.push({...def,results,loadedJson:JSON.stringify(loaded),appliedJson:JSON.stringify(applied),claim,disk,rootExists:existsSync(rebinds)});
}finally{rmSync(work,{recursive:true,force:true});}}return cases;}
const cases=await record();assert.deepEqual(await record(),cases);writeFileSync(new URL('./golden/rebind-ledger.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},id,second,from,to,now,cases},null,2)+'\n');console.log(`Recorded ${cases.length} actual Node rebind ledger cases twice`);
