// Actual local-provider construction only; no embedding, artifact loading or download.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.ok(root);assert.equal(process.version,'v24.21.0');
const source=JSON.parse(readFileSync(new URL('./reembedding-sources.json',import.meta.url),'utf8'));const paths=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith('.js'))paths.push(p);}}
walk(path.join(root,'engine'));walk(path.join(root,'lib'));const hash=createHash('sha256');for(const p of paths.sort()){hash.update(`${path.relative(root,p)}\0`);hash.update(readFileSync(p));hash.update('\0');}assert.equal(hash.digest('hex'),source.treeSha256);
const {normalizeEmbeddingConfig}=await import(pathToFileURL(path.join(root,'lib/providers/config-normalize.js')));
const {embeddingFingerprintFromNormalizedConfig,embeddingConfigFromSelection}=await import(pathToFileURL(path.join(root,'lib/reembedding/runtime-config.js')));
const {LocalTransformersEmbeddingProvider}=await import(pathToFileURL(path.join(root,'lib/providers/embedding-local-transformers.js')));
const {embeddingIdentity,identityId}=await import(pathToFileURL(path.join(root,'lib/providers/embedding-identity.js')));
async function run(){const out=[];for(const model of ['intfloat/multilingual-e5-small','google/embeddinggemma-2'])for(const cap of [null,256,512]){
 const input={provider:'local-transformers',local:{model,...(cap===null?{}:{maxTokens:cap})}};
 const normalized=normalizeEmbeddingConfig(input);const fingerprint=embeddingFingerprintFromNormalizedConfig(normalized);
 const projected=embeddingConfigFromSelection({fingerprint},{});const effective=normalizeEmbeddingConfig(projected);
 const provider=new LocalTransformersEmbeddingProvider({...effective.local,model:effective.model,dimensions:effective.dimensions,embeddingCacheEnabled:false,cacheDir:'/synthetic/unopened-cache'});
 try{const plannedIdentity=embeddingIdentity(fingerprint),actualIdentity=provider.identity;out.push({model,cap,input,fingerprint,plannedIdentity,actualIdentity,plannedId:identityId(plannedIdentity),actualId:identityId(actualIdentity),...(identityId(plannedIdentity)!==identityId(actualIdentity)?{rustException:'local-prefix-token-cap'}:{})});}finally{await provider.shutdown();}
}return out;}
const recorded=await run();assert.deepEqual(await run(),recorded);writeFileSync(new URL('./golden/reembedding-provider-identity.json',import.meta.url),JSON.stringify({recordedFrom:{engine:'node',source,node:process.version},cases:recorded},null,2)+'\n');console.log(`Recorded ${recorded.length} actual Node provider identities twice without inference`);
