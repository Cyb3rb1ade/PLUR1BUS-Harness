// Pure projection from the frozen C2 runtime-config module; no provider creation.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,'v24.21.0');
const source=JSON.parse(readFileSync(new URL('./reembedding-sources.json',import.meta.url),'utf8'));const paths=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith('.js'))paths.push(p);}}
walk(path.join(root,'engine'));walk(path.join(root,'lib'));const hash=createHash('sha256');for(const p of paths.sort()){hash.update(`${path.relative(root,p)}\0`);hash.update(readFileSync(p));hash.update('\0');}assert.equal(hash.digest('hex'),source.treeSha256);
const runtime=await import(pathToFileURL(path.join(root,'lib/reembedding/runtime-config.js')));
const {pinnedLocalModelProfile}=await import(pathToFileURL(path.join(root,'lib/providers/local-model-artifacts.js')));
const ref={source:'env',provider:'default',id:'SYNTHETIC_EMBEDDING_KEY'};
const cases=[];const add=(kind,name,input)=>cases.push({kind,name,input});
for(const model of ['intfloat/multilingual-e5-small','google/embeddinggemma-2']){
 const p=pinnedLocalModelProfile(model);assert.ok(p);const fp={provider:'local-transformers',model,revision:p.revision,dimensions:model.startsWith('intfloat')?384:768,queryPrefix:(p.queryPrefix??'query: ').trim(),passagePrefix:(p.passagePrefix??'passage: ').trim(),dtype:p.dtype};
 for(const [name,change]of [['base',{}],['token-cap',{tokenCap:256}],['custom-prefix',{queryPrefix:'custom query ',passagePrefix:'custom passage '}],['empty-prefix',{queryPrefix:'',passagePrefix:''}],['dtype-override',{dtype:'fp32'}]]){
  const fingerprint={...fp,...change};add('projection',`${model}/${name}`,{selection:{fingerprint,secretRef:ref},current:{fallback:{enabled:true,model:'synthetic-fallback'},local:{cacheDir:'/synthetic/cache'}}});
  add('local-options',`${model}/${name}`,fingerprint);
 }
}
for(const [name,fp]of [['minimal',{provider:'openai',model:'synthetic-target',dimensions:8}],['identity-fields',{provider:'openai',model:'synthetic-target',dimensions:8,endpoint:'https://example.invalid/v1',revision:'revision-a',normalization:'unit',dtype:'float32',prefixScheme:'synthetic-prefix',instruction:'synthetic instruction'}]])add('projection',name,{selection:{fingerprint:fp,secretRef:ref},current:{fallback:{enabled:false}}});
for(const [name,input]of [['local',{provider:'local-transformers',apiKey:ref}],['ref',{apiKey:ref}],['env',{apiKeyEnv:'SYNTHETIC_KEY'}],['env-precedes-literal',{apiKeyEnv:'SYNTHETIC_KEY',apiKey:'not-a-credential'}],['template',{apiKey:' ${SYNTHETIC_KEY} '}],['literal',{apiKey:'not-a-credential'}],['missing',{}],['null',{apiKey:null}],['false',{apiKey:false}],['array',{apiKey:[]}],['bad-source',{apiKey:{...ref,source:'remote'}}],['bad-provider',{apiKey:{...ref,provider:'Invalid'}}],['extra-field',{apiKey:{...ref,extra:true}}],['empty-id',{apiKey:{...ref,id:''}}],['long-id',{apiKey:{...ref,id:'x'.repeat(257)}}],['unicode-limit',{apiKey:{...ref,id:'😀'.repeat(128)}}],['unicode-over',{apiKey:{...ref,id:'😀'.repeat(129)}}]])add('secret-ref',name,input);
for(const [name,secretRef]of [['literal-reference','not-a-credential'],['extra-reference-field',{...ref,extra:true}],['invalid-reference-provider',{...ref,provider:'Invalid'}]])cases.push({kind:'projection',name,input:{selection:{fingerprint:{provider:'openai',model:'synthetic-target',dimensions:8},secretRef},current:{}},rustException:'invalid-reference'});
add('local-options','unknown',{model:'synthetic-unknown',revision:'a'});add('local-options','wrong-revision',{model:'intfloat/multilingual-e5-small',revision:'wrong'});
function run(){return cases.map(c=>{try{const value=c.kind==='projection'?runtime.embeddingConfigFromSelection(c.input.selection,c.input.current):c.kind==='secret-ref'?runtime.redactedEmbeddingSecretRef(c.input):runtime.localEmbeddingOptionsFromFingerprint(c.input);return{...c,value};}catch(e){return{...c,error:e.message};}});}
const recorded=run();assert.deepEqual(run(),recorded);writeFileSync(new URL('./golden/reembedding-projection.json',import.meta.url),JSON.stringify({recordedFrom:{engine:'node',source,node:process.version},cases:recorded},null,2)+'\n');console.log(`Recorded ${recorded.length} actual Node projection cases twice`);
