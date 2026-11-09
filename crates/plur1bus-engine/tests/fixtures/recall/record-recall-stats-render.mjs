// Actual A1 assembler post-render hook; expected data is never constructed by Rust.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureRender} from './render-runtime.mjs';
import {row,id} from './render-scenarios.mjs';
process.env.TZ = 'UTC';
const pin='9b935ce1f970bd92a931aa99a58c620669c8085f';
const root=process.env.PLUR1BUS_ENGINE_SRC, git=process.env.PLUR1BUS_ENGINE_GIT;
assert(root&&git&&process.version==='v24.21.0');
const sha=b=>createHash('sha256').update(b).digest('hex');
const paths=execFileSync('git',['-C',git,'ls-tree','-r','--name-only',pin],{encoding:'utf8'}).trim().split('\n').filter(p=>p==='package.json'||/^(engine|lib)\/.*\.(js|json)$/.test(p));
const sourceHashes=paths.map(path=>{
 const bytes=readFileSync(join(root,path));
 assert.equal(sha(bytes),sha(execFileSync('git',['-C',git,'show',`${pin}:${path}`])));
 return {path,sha256:sha(bytes)};
});
const record=(n)=>`<memory-record id="${id(n)}"><text>synthetic evidence ${n}</text></memory-record>`;
const cached=(text,cap=null,degraded=null)=>({blocks:[{name:'memories',text,droppable:true,chars:text.length}],capChars:cap,degraded});
const cases=[
 {variant:'actual-render',rows:[row(1),row(2)]},
 {variant:'actual-warm',rows:[row(1)],warm:true},
 {variant:'actual-degraded',rows:[row(1)],pipelineError:true},
 {variant:'cached-full',cachedResult:cached(record(1)+record(2))},
 {variant:'cached-first-only',cachedResult:cached(record(1)+record(2),record(1).length+40)},
 {variant:'cached-drop-all',cachedResult:cached(record(1)+record(2),1)},
 {variant:'cached-degraded',pipelineError:true,cachedResult:cached(record(1),null,{reason:'timeout'})},
 {variant:'cached-duplicate',cachedResult:cached(record(1)+record(1))},
 {variant:'cached-unclosed',cachedResult:cached(`<memory-record id="${id(1)}">unfinished`)},
 {variant:'cached-uppercase',cachedResult:cached('<MEMORY-RECORD ID="AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA">evidence</MEMORY-RECORD>')},
 {variant:'statistics-failure',rows:[row(1)],statsError:true},
];
const capture=async()=>{
 const values=await captureRender(root,{scenarios:{stats:cases},stats:true});
 return values.stats.map(c=>({input:c.input,result:c.result,joined:c.joined,calls:c.calls.stats||[]}));
};
const oldFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('network forbidden');};
try{
 const first=await capture();assert.deepEqual(await capture(),first);
 const output=JSON.stringify({pin,node:process.version,sourceHashes,boundaries:{assembler:'actual A1 exported assembler',selection:'synthetic authorized T5 rows',cache:'injected scheduler returns, not a cache implementation',statistics:'record collaborator observed; SQLite tested separately',clock:'explicit frozen synthetic time'},cases:first},null,2)+'\n';
 writeFileSync(join(dirname(fileURLToPath(import.meta.url)),'golden/recall-stats-render.json'),output);
 console.log(`Recorded ${first.length} actual A1 assembler cases twice; SHA-256 ${sha(output)}`);
}finally{globalThis.fetch=oldFetch;}
