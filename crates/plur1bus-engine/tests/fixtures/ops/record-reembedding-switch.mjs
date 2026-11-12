// Frozen C2 switch/recovery with its real durable state store and explicit synthetic host ports.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,'v24.21.0');
const source=JSON.parse(readFileSync(new URL('./reembedding-sources.json',import.meta.url),'utf8'));const paths=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith('.js'))paths.push(p);}}
walk(path.join(root,'engine'));walk(path.join(root,'lib'));const hash=createHash('sha256');for(const p of paths.sort()){hash.update(`${path.relative(root,p)}\0`);hash.update(readFileSync(p));hash.update('\0');}assert.equal(hash.digest('hex'),source.treeSha256);
const {createReembeddingSwitchRuntime,createReembeddingSwitchRecovery}=await import(pathToFileURL(path.join(root,'lib/reembedding/switch-runtime.js')));
const {createMigrationStateStore}=await import(pathToFileURL(path.join(root,'lib/reembedding/state-store.js')));
const {createMigrationConfirmation}=await import(pathToFileURL(path.join(root,'lib/reembedding/confirmation.js')));
const {normalizeEmbeddingFingerprint}=await import(pathToFileURL(path.join(root,'lib/reembedding/fingerprint.js')));
const fp=model=>normalizeEmbeddingFingerprint({provider:'openai',model,dimensions:3},[]);
const proofSeed=9,planDigest=`sha256:${'a'.repeat(64)}`;
const confirmation=createMigrationConfirmation({planDigest,expiresAt:10000,randomBytes:()=>Buffer.alloc(32,proofSeed)});
const seed={id:'migration-switch',state:'planned',planDigest,confirmation:confirmation.persisted,
 source:{generation:'source-generation',selection:{mode:'legacy'},fingerprint:fp('synthetic-source'),fingerprintId:'source-id',secretRef:{source:'env',provider:'default',id:'SYNTHETIC_SOURCE_KEY'},tables:[],configRevision:'config-a'},
 target:{generation:'target-generation',fingerprint:fp('synthetic-target'),fingerprintId:'target-id'},
 cursor:{tableIndex:0,offset:0,completedRows:0,providerCalls:0,bytes:0},receipts:{validation:{semanticRecall:true}}};
const cases=[
 {name:'target-completes',steps:[{op:'switch'},{op:'recover',active:'target-generation'}]},
 {name:'source-drift',steps:[{op:'switch',drift:true}]},
 {name:'mutation-fails',steps:[{op:'switch',mutationFails:true},{op:'recover',active:null}]},
 {name:'gate-enter-fails',steps:[{op:'switch',enterFails:true}]},
 {name:'gate-exit-fails',steps:[{op:'switch',exitFails:true}]},
 {name:'wrong-proof',steps:[{op:'switch',wrongProof:true}]},
 {name:'remote-source-without-reference',omitReference:true,steps:[{op:'switch'}]},
 {name:'missing-validation',omitValidation:true,steps:[{op:'switch'}]},
 {name:'early-switch',initial:'planned',steps:[{op:'switch'}]},
 {name:'empty-recovery',steps:[{op:'recover',active:'target-generation'}]},
 {name:'target-probe-rollback',steps:[{op:'switch'},{op:'recover',active:'target-generation',probeFails:true},{op:'recover',active:null}]},
 {name:'target-probe-mutation-fails',steps:[{op:'switch'},{op:'recover',active:'target-generation',probeFails:true,mutationFails:true},{op:'recover',active:'target-generation'},{op:'recover',active:null}]},
 {name:'source-not-activated',steps:[{op:'switch'},{op:'recover',active:null}]},
 {name:'source-probe-fails',steps:[{op:'switch'},{op:'recover',active:null,probeFails:true},{op:'recover',active:null}]},
 {name:'active-selection-drift',steps:[{op:'switch'},{op:'recover',active:'unrelated-generation'}]},
 {name:'invalid-probe-receipt',steps:[{op:'switch'},{op:'recover',active:'target-generation',probe:{readiness:true,store:true,recall:false}},{op:'recover',active:null}]},
 {name:'generation-source',generationSource:true,steps:[{op:'switch'},{op:'recover',active:'source-generation'}]},
 {name:'manual-reverse',steps:[{op:'switch'},{op:'recover',active:'target-generation'},{op:'manual',newId:'reverse-migration'}]},
 {name:'manual-before-completion',steps:[{op:'manual',newId:'reverse-migration'}]},
 {name:'manual-invalid-id',steps:[{op:'switch'},{op:'recover',active:'target-generation'},{op:'manual',newId:'../invalid'}]},
];
async function run(){const out=[];for(const c of cases){const work=mkdtempSync(path.join(tmpdir(),'rx5-switch-'));const store=createMigrationStateStore({stateRoot:work,now:()=>1000});const input=structuredClone(seed);if(c.omitReference)delete input.source.secretRef;if(c.omitValidation)input.receipts={};if(c.generationSource)input.source.selection={mode:'generation',generation:'source-generation'};
 let record=await store.create(input);if(c.initial!=='planned')for(const [a,b]of [['planned','confirmed'],['confirmed','running'],['running','validating'],['validating','ready_to_switch']])record=await store.transition(input.id,a,b,{expectedRevision:record.revision});
 const initial=store.get(input.id),results=[];try{for(const step of c.steps){const calls=[];const mutateSelection=async selection=>{calls.push({kind:'mutate',selection});if(step.mutationFails)throw Error('synthetic config mutation failed');};
 const runtime=createReembeddingSwitchRuntime({stateStore:store,now:()=>1000,maintenanceGate:{enter:async()=>{calls.push({kind:'enter'});if(step.enterFails)throw Error('synthetic gate enter failed');},exit:async()=>{calls.push({kind:'exit'});if(step.exitFails)throw Error('synthetic gate exit failed');}},assertSourceCurrent:async()=>{calls.push({kind:'source-check'});if(step.drift)throw Error('synthetic source drift');},mutateSelection});
 let result;try{let value;if(step.op==='switch')value=await runtime.switchGeneration({id:input.id,token:step.wrongProof?'invalid-proof':confirmation.token});else if(step.op==='manual')value=await runtime.planManualRollback({completedId:input.id,newMigrationId:step.newId});else{const recovery=createReembeddingSwitchRecovery({stateStore:store,readActiveSelection:()=>({generation:step.active}),mutateSelection,probeRuntime:async request=>{calls.push({kind:'probe',request});if(step.probeFails)throw Error('synthetic runtime probe failed');return step.probe??{readiness:true,store:true,recall:true};}});value=await recovery.start();await recovery.shutdown();}result={value};}catch(e){result={error:e.message};}results.push({...result,calls,state:store.get(input.id)});}
 out.push({...c,initial,results});}finally{rmSync(work,{recursive:true,force:true});}}
 return out;}
const recorded=await run();assert.deepEqual(await run(),recorded);writeFileSync(new URL('./golden/reembedding-switch.json',import.meta.url),JSON.stringify({recordedFrom:{engine:'node',source,node:process.version},proofSeed,cases:recorded},null,2)+'\n');console.log(`Recorded ${recorded.length} actual Node switch/recovery cases twice`);
