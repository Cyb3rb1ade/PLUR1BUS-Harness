// Actual pinned Engine facade, real Lance stores, synthetic providers, no network.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,'v24.21.0');
const sourcePath=path.join(root,'engine/create-engine.js');
const sourceSha256=createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
assert.equal(sourceSha256,'616601790f1859fee2a61494bfd2ed8cd82874bdc759c37b8e5295c183028ed6');
const {createEngine}=await import(pathToFileURL(sourcePath));
const {normalizeEmbeddingFingerprint}=await import(pathToFileURL(path.join(root,'lib/reembedding/fingerprint.js')));
const {config,flatEmbedder,seedAndGetId,twoWorkspaceHost}=await import(pathToFileURL(path.join(root,'tests/helpers/shared-workspace-engine.js')));
const {prepareEngineSharedBase}=await import(pathToFileURL(path.join(root,'tests/helpers/win32-shared-owner.js')));
const cases=[{name:'ready',count:2,mode:'flat'},{name:'empty',count:0,mode:'error'},{name:'query-error',count:1,mode:'error'},{name:'recall-miss',count:6,mode:'miss'}];
async function run(){const results=[];for(const c of cases){
 const work=mkdtempSync(path.join(tmpdir(),'rx5-validation-'));const {host}=twoWorkspaceHost(path.join(work,'state'));let queries=0;
 const axes=new Map();const one=i=>Array.from({length:8},(_,j)=>+(i===j));
 const passage=text=>{if(!axes.has(text))axes.set(text,axes.size);return c.mode==='miss'?one(axes.get(text)):one(0);};
 const query=text=>{queries++;if(c.mode==='error')throw Error('synthetic query failed');if(c.mode!=='miss')return one(0);const others=[...axes].filter(([t])=>t!==text).map(([,a])=>a);return Array.from({length:8},(_,i)=>others.includes(i)?1/Math.sqrt(others.length):0);};
 const engine=prepareEngineSharedBase(createEngine(host,config(path.join(work,'source')),{internals:{embeddings:flatEmbedder(),reembeddingTargetProvider:()=>({embed:async text=>passage(text),embedPassage:async text=>passage(text),embedBatch:async texts=>texts.map(passage),embedQuery:async text=>query(text),shutdown:async()=>{}})}}));
 try{
  if(c.count===0)await engine.open('anna');
  for(let i=0;i<c.count;i++)await seedAndGetId(engine,'anna',`VALIDATE_SENTINEL fact number ${i} about the lighthouse keeper`,`fact number ${i}`);
  const planned=await engine.admin.reembedding.plan({id:'semantic-validation',target:{fingerprint:normalizeEmbeddingFingerprint({provider:'openai',model:'synthetic-target',dimensions:8},[])}});
  let record=await engine.admin.reembedding.apply({id:'semantic-validation',token:planned.confirmation.token});
  for(let i=0;i<20&&record.state==='running';i++)record=await engine.admin.reembedding.resume({id:'semantic-validation',token:planned.confirmation.token});
  assert.equal(record.state,'validating');queries=0;
  let error=null;try{record=await engine.admin.reembedding.validate({id:'semantic-validation'});}catch(e){error=e.message;record=await engine.admin.reembedding.status('semantic-validation');}
  const v=record.receipts.validation;
  results.push({...c,queries,error,state:record.state,validation:v?{semanticRecall:v.semanticRecall,rows:v.rows,validationMemoryIdPresent:v.validationMemoryId!==null,validationTable:v.validationTable}:null});
 }finally{await engine.close({budgetMs:5000});rmSync(work,{recursive:true,force:true});}
}return results;}
const recorded=await run();assert.deepEqual(await run(),recorded);
writeFileSync(new URL('./golden/reembedding-validation.json',import.meta.url),JSON.stringify({recordedFrom:{engine:'node',pin:'9f34008c143c5da87b2194b5a28442b407ff8ba7',source:'engine/create-engine.js',sourceSha256,node:process.version},cases:recorded},null,2)+'\n');
console.log(`Recorded ${recorded.length} actual Engine validation cases twice`);
