// Actual C3 unimport sidecars: generation markers, repair and fenced append.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,'v24.21.0');
const source=JSON.parse(readFileSync(new URL('./unimport-sources.json',import.meta.url),'utf8'));
const files=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.js'))files.push(f);}}
walk(path.join(root,'engine'));walk(path.join(root,'lib'));const hash=createHash('sha256');for(const f of files.sort()){hash.update(`${path.relative(root,f)}\0`);hash.update(readFileSync(f));hash.update('\0');}assert.equal(hash.digest('hex'),source.treeSha256);
const {createUnimportLedger}=await import(pathToFileURL(path.join(root,'engine/memory-ops/unimport-ledger.js')));
const {memoryOpError}=await import(pathToFileURL(path.join(root,'engine/memory-ops/errors.js')));
const now=1800000000000,agent='agent',run='run-1';const card='33333333-3333-4333-8333-333333333333';
const header={v:1,kind:'header',agentId:agent,importRunId:run,createdAt:now};const intent={v:1,kind:'intent',cardId:card,idempotencyKey:'key',importedAt:100,archived:true};const done={v:1,kind:'done',cardId:card,importedAt:100};
const h={op:'header'},i={op:'intent',cardId:card,idempotencyKey:'key',importedAt:100},d={op:'done',cardId:card,importedAt:100};const lines=rows=>rows.map(JSON.stringify).join('\n')+'\n';
const defs=[
{name:'missing-read',ops:[]},{name:'missing-prepare',ops:[{op:'prepare'}]},
{name:'header-idempotent',ops:[h,h]}, {name:'intent-then-done',ops:[h,i,d]},
{name:'reimport-generation-separated',ops:[h,i,d,{...i,importedAt:101}]},
{name:'duplicate-markers',initial:lines([header,intent,intent,done,done]),ops:[]},
{name:'last-header-opaque',initial:lines([header,{...header,opaque:'old\ud800'}]),ops:[h]},
{name:'foreign-malformed-lines',initial:['{bad',JSON.stringify({...header,v:2}),JSON.stringify(header),JSON.stringify({...intent,cardId:7}),JSON.stringify(intent)].join('\n')+'\n',ops:[]},
{name:'number-coercion-markers',initial:lines([header,...['100','0x64',null,'nonsense',true,[],[1],{},'Infinity'].flatMap(importedAt=>[{...intent,importedAt},{...done,importedAt}])]),ops:[]},
{name:'opaque-card-and-key',initial:lines([header,{...intent,cardId:'legacy\ud800',idempotencyKey:'opaque\udfff'},{...done,cardId:'legacy\ud800'}]),ops:[]},
{name:'torn-prepare-keeps-header',initial:lines([header])+JSON.stringify(intent).slice(0,50),ops:[{op:'prepare'},i]},
{name:'valid-tail-no-newline-dropped',initial:lines([header])+JSON.stringify(intent),ops:[{op:'prepare'},d]},
{name:'large-torn-tail-crosses-read-chunk',initial:lines([header])+'x'.repeat(70000),ops:[{op:'prepare'},i]},
{name:'torn-append-repaired',initial:lines([header])+'{torn',ops:[i]},
{name:'torn-only-quarantined-prepare',initial:'{torn',ops:[{op:'prepare'}]},
{name:'torn-only-quarantined-header',initial:'{torn',ops:[h]},
{name:'valid-header-no-newline-quarantined',initial:JSON.stringify(header),ops:[i]},
{name:'lock-lost-before-header',ops:[{op:'header',loseLock:true}]},
];
function record(){const cases=[];for(const def of defs){const work=mkdtempSync(path.join(tmpdir(),'rx3-unimport-ledger-'));const baseDbPath=path.join(work,'store');mkdirSync(baseDbPath);const folder=path.join(baseDbPath,'_unimports',agent);const file=path.join(folder,run+'.jsonl');try{
if(def.initial!==undefined){mkdirSync(folder,{recursive:true});writeFileSync(file,def.initial);}
const ledger=createUnimportLedger({baseDbPath,clock:()=>now});const results=[];for(const op of def.ops){const fence=()=>{if(op.loseLock)throw memoryOpError('lock-lost','synthetic replaced owner')};try{switch(op.op){case'prepare':ledger.prepare(agent,run);break;case'header':ledger.ensureHeader(agent,run,fence);break;case'intent':ledger.appendIntent(agent,run,op,fence);break;case'done':ledger.appendDone(agent,run,op,fence);break;}results.push({ok:true});}catch(e){assert.equal(typeof e.code,'string');results.push({error:e.code});}}
const state=ledger.load(agent,run);const loadedJson=JSON.stringify({...state,intents:[...state.intents].sort(),done:[...state.done].sort()});const disk={};if(existsSync(folder))for(const name of readdirSync(folder).sort())disk[name]=readFileSync(path.join(folder,name),'utf8');cases.push({...def,results,loadedJson,disk,rootExists:existsSync(path.join(baseDbPath,'_unimports'))});
}finally{rmSync(work,{recursive:true,force:true});}}return cases;}
const cases=record();assert.deepEqual(record(),cases);writeFileSync(new URL('./golden/unimport-ledger.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},now,agent,run,cases},null,2)+'\n');console.log(`Recorded ${cases.length} actual Node unimport ledger cases twice`);
