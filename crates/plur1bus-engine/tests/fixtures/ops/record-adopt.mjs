// Actual C3 read-only status aggregation. No provider is probed and no memory store is opened.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync,cpSync,symlinkSync,existsSync,lstatSync} from 'node:fs';
import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,'v24.21.0');
const source=JSON.parse(readFileSync(new URL('./adopt-sources.json',import.meta.url),'utf8'));
const files=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.js'))files.push(f);}}
walk(path.join(root,'engine'));walk(path.join(root,'lib'));const hash=createHash('sha256');for(const f of files.sort()){hash.update(`${path.relative(root,f)}\0`);hash.update(readFileSync(f));hash.update('\0');}assert.equal(hash.digest('hex'),source.treeSha256);
import {tmpdir} from 'node:os';
const load=f=>import(pathToFileURL(path.join(root,f)));
const {createStoreAdopt}=await load('engine/stores/adopt.js');
const {AgentDbPool}=await load('engine/store/agent-db-pool.js');
const lance=await import(pathToFileURL(path.join(root,'node_modules/@lancedb/lancedb/dist/index.js')));
const identity={fingerprintId:`embedding:v1:sha256:${'a'.repeat(64)}`,provider:'local-transformers',model:'synthetic',dimensions:4};
const storeFixtures=new URL('./adopt-stores/',import.meta.url);mkdirSync(storeFixtures,{recursive:true});
const row=(text,vector=[1,0,0,0],status='active')=>({text,vector,status});
const tables={normal:[row(' alpha '),row('beta')],statuses:[row('active'),row('null-status',[1,0,0,0],null),row('empty-status',[1,0,0,0],''),row('deleted',[0,1,0,0],'deleted')],legacy:[{text:'legacy',vector:[1,0,0,0]}],wrongdim:[row('dimension',[1,0,0])],deleted:[row('deleted',[0,1,0,0],'deleted')],invalid:[row('zero',[0,0,0,0]),row('  '),row('nonfinite',[NaN,0,0,0])],paged:[...Array.from({length:205},()=>row('  ')),row('after-page')],many:Array.from({length:20},(_,i)=>row(`many-${i}`)),second:[row('second',[0,1,0,0])],empty:[row('remove-me')]};
for(const [name,rows] of Object.entries(tables)) {const location=new URL(`${name}/`,storeFixtures);rmSync(location,{recursive:true,force:true});mkdirSync(location,{recursive:true});const db=await lance.connect(location.pathname);const table=await db.createTable('memories',rows);if(name==='empty')await table.delete('true');table.close();db.close();}
const defs=[
{name:'normal',table:'normal'},{name:'null-empty-active-status',table:'statuses'},{name:'round-robin-detect-second',table:'many',second:'second',embed:'uniform'},{name:'eight-finite-scores',table:'many',embed:'half'},{name:'seven-finite-scores',table:'many',embed:'seven'},{name:'normal-apply',table:'normal',dryRun:false},{name:'legacy-status',table:'legacy'},
{name:'paging-invalid-prefix',table:'paged'},{name:'zero-empty-nan',table:'invalid'},{name:'deleted',table:'deleted'},
{name:'wrong-stored-dimension',table:'wrongdim'},{name:'empty',table:'empty'},{name:'round-robin',table:'many',second:'second'},
{name:'named-layout',table:'normal',namespace:'named'},{name:'leading-hyphen-agent',table:'normal',agent:'-agent'},
{name:'dot-agent-skipped',table:'normal',agent:'agent.dot'},{name:'symlink-agent-skipped',table:'normal',linkAgent:true},
{name:'missing',missing:true},{name:'empty-directory',noSchema:true},{name:'schema-zero',schema:'0'},
{name:'schema-seven',schema:'7'},{name:'schema-bad',schema:'bad'},{name:'schema-malformed',schemaRaw:'{'},{name:'marker-directory',markerDirectory:true},
{name:'table-without-marker',table:'normal',noSchema:true},{name:'provider-no-identity',noIdentity:true},
{name:'provider-zero-dimension',engine:{dimensions:0}},{name:'provider-dimension',engine:{dimensions:3}},
{name:'provider-fingerprint',engine:{fingerprintId:'different'}},{name:'probe-throws',table:'normal',embed:'throws'},
{name:'probe-count',table:'normal',embed:'count'},{name:'probe-dimension',table:'normal',embed:'dimension'},
{name:'probe-zero',table:'normal',embed:'zero'},{name:'probe-nan',table:'normal',embed:'nan'},
{name:'probe-mismatch',table:'normal',embed:'other'},{name:'median-floor',table:'normal',embed:'median'},
{name:'minimum-floor',table:'normal',embed:'minimum'},{name:'manifest-empty',generation:true},
{name:'manifest-table',generation:true,genTable:'normal'},{name:'manifest-incorrect-schema',generation:{schemaVersion:2}},
{name:'manifest-missing-tables',generation:{tables:null}},{name:'manifest-wrong-fingerprint',generation:{fingerprintId:'different'}},
{name:'manifest-wrong-dimension',generation:{dimensions:3}},{name:'manifest-malformed',generationRaw:'{'},
{name:'manifest-provider-conflict',generation:true,engine:{fingerprintId:'different'}},
{name:'manifest-invalid-table',generation:true,genTable:'invalid'},
{name:'invalid-dimension',request:{expectedIdentity:{...identity,dimensions:0}}},
{name:'path-relative',relative:true},{name:'path-traversal',traversal:true},{name:'unsafe-host',unsafe:true},{name:'symlink-root',symlink:true}
];
function snapshot(dir){const entries=[];function visit(p,relative=''){for(const name of readdirSync(p).sort()){const f=path.join(p,name),key=path.join(relative,name),st=lstatSync(f);if(st.isSymbolicLink()){entries.push([key,'symlink']);continue;}if(st.isDirectory()){entries.push([key,'dir']);visit(f,key);}else entries.push([key,createHash('sha256').update(readFileSync(f)).digest('hex')]);}}if(existsSync(dir))visit(dir);return entries;}
async function record(){const out=[];for(const def of defs){const work=mkdtempSync(path.join(tmpdir(),'rx3-adopt-'));const base=path.join(work,'store');let calls=[];try{
if(!def.missing)mkdirSync(base);if(!def.missing&&!def.noSchema){if(def.markerDirectory)mkdirSync(path.join(base,'_schema.json'));else writeFileSync(path.join(base,'_schema.json'),def.schemaRaw??JSON.stringify({schemaVersion:def.schema??'1'}));}
const copy=(name,destination)=>{mkdirSync(path.dirname(destination),{recursive:true});cpSync(new URL(`${name}/`,storeFixtures),destination,{recursive:true});};
if(def.table){const dest=path.join(base,...(def.namespace?[def.namespace]:[]),def.agent??'agent');copy(def.table,def.linkAgent?path.join(work,'linked'):dest);if(def.linkAgent)symlinkSync(path.join(work,'linked'),dest,'dir');}
if(def.second)copy(def.second,path.join(base,'z-agent'));
if(def.generation||def.generationRaw){const gen=path.join(base,'generations','g1');mkdirSync(gen,{recursive:true});writeFileSync(path.join(gen,'generation.json'),def.generationRaw??JSON.stringify({schemaVersion:1,generation:'g1',...identity,tables:{},...(def.generation===true?{}:def.generation)}));if(def.genTable)copy(def.genTable,path.join(gen,'agent'));}
let requested=base;if(def.relative)requested='relative';if(def.traversal)requested=path.join(base,'x')+'/../';if(def.symlink){requested=path.join(work,'link');symlinkSync(base,requested,'dir');}
const before=snapshot(work);const api=createStoreAdopt({baseDbPath:path.join(work,'engine'),pool:{},embeddings:{embedBatch:async(texts,concurrency,options)=>{calls.push({texts,concurrency,options});if(def.embed==='throws')throw new Error('synthetic');if(def.embed==='count')return [];return texts.map((text,i)=>(def.embed==='half'&&i>=8)||(def.embed==='seven'&&i>=7)?[NaN,0,0,0]:def.embed==='dimension'?[1,0,0]:def.embed==='zero'?[0,0,0,0]:def.embed==='nan'?[NaN,0,0,0]:def.embed==='other'?[0,1,0,0]:def.embed==='median'?[0.9994,Math.sqrt(1-0.9994**2),0,0]:def.embed==='minimum'?(i===0?[0.9989,Math.sqrt(1-0.9989**2),0,0]:[1,0,0,0]):text==='second'&&def.embed!=='uniform'?[0,1,0,0]:[1,0,0,0]);}},getIdentity:()=>def.noIdentity?null:{...identity,...def.engine},vectorDim:4,host:{platform:{isUnsafeLink:p=>def.unsafe===true||(existsSync(p)&&lstatSync(p).isSymbolicLink())}},logger:{warn(){},debug(){}},AgentDbPool});
let result;try{result=await api.adopt({path:requested,expectedIdentity:identity,dryRun:def.dryRun??true,...def.request});}catch(e){result={error:e.code??'unknown'};}
assert.deepEqual(snapshot(work),before,`${def.name} wrote to the copied store`);out.push({...def,result,calls});
}finally{rmSync(work,{recursive:true,force:true});}}
return out;}
const cases=await record();assert.deepEqual(await record(),cases);writeFileSync(new URL('./golden/adopt.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},identity,cases},null,2)+'\n');console.log(`Recorded ${cases.length} real Node/Lance adoption cases twice, all source trees byte-unchanged`);
