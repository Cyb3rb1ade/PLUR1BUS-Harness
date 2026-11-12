// RE-05/T4: execute the pinned Node effect with an offline recording DB adapter.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const pin = '9f34008c143c5da87b2194b5a28442b407ff8ba7';
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== 'v24.21.0') throw new Error('verified source and Node24 required');
const sourcesSha256 = {};
for (const name of ['lib/retroactive-interference.js', 'lib/memory-dynamics.js']) {
  const bytes = readFileSync(join(root, name));
  assert.deepEqual(bytes, execFileSync('git', ['-C', git, 'show', `${pin}:${name}`]));
  sourcesSha256[name] = createHash('sha256').update(bytes).digest('hex');
}
const { applyRetroactiveInterference } = await import(pathToFileURL(join(root, 'lib/retroactive-interference.js')));
const now = 1735689600000;
const oldDateNow = Date.now;
Date.now = () => now;
const source = { id: 'new', vector: [1, 0] };
const row = (id, more = {}) => ({ id, memoryStrength: 0.8, halfLifeDays: 30, createdAt: now, ...more });
const cases = [
 { name: 'ordinary', candidates: [row('a'), row('b')] },
 { name: 'self-and-missing', candidates: [row('new'), {}, row('a')] },
 { name: 'core-markers', candidates: [row('a',{memoryClass:'core'}),row('b',{neverForget:true}),row('c',{neverForget:1}),row('d',{neverForget:'1'}),row('e',{memoryClass:'CORE'}),row('f')] },
 { name: 'max-affected', candidates: Array.from({length:8},(_,i)=>row(`a${i}`)), options: {maxAffected:3} },
 { name: 'zero-affected', candidates:[row('a')], options:{maxAffected:0} },
 { name: 'half-life', candidates:[row('a',{createdAt:now-30*86400000}),row('b',{createdAt:now-60*86400000}),row('c',{createdAt:now-10000*86400000})] },
 { name: 'strength-floor', candidates:[row('a',{memoryStrength:0}),row('b',{memoryStrength:0.01}),row('c',{memoryStrength:1})] },
 { name: 'custom-multiplier', candidates:[row('a'),row('b')], options:{multiplier:0.5,threshold:0.8,maxAffected:1} },
 { name: 'zero-multiplier', candidates:[row('a')], options:{multiplier:0} },
 { name: 'no-candidates', candidates:[] },
 { name: 'disabled', candidates:[row('a')], options:{enabled:false} },
 { name: 'missing-id', source:{vector:[1,0]}, candidates:[row('a')] },
 { name: 'missing-vector', source:{id:'new'}, candidates:[row('a')] },
 { name: 'future-clock', candidates:[row('a',{lastDynamicsAt:now+86400000})] },
 { name: 'dynamics-clock', candidates:[row('a',{lastDynamicsAt:now-86400000,lastStrengthenedAt:now}),row('b',{lastStrengthenedAt:now-86400000}),row('c',{lastDynamicsAt:0})] },
 { name: 'duplicates', candidates:[row('a'),row('a')] },
 { name: 'empty-vector', source:{id:'new',vector:[]}, candidates:[row('a')] },
 { name: 'invalid-threshold', options:{threshold:1.1}, candidates:[row('a')] },
 { name: 'amplifying-multiplier', options:{multiplier:2}, candidates:[row('a')] },
 { name: 'over-limit', options:{maxAffected:65}, candidates:[] },
 { name: 'oversized-candidates', candidates:Array.from({length:66},(_,i)=>row(`v${i}`)) },
 { name: 'search-failure', candidates:[], failSearch:true },
 { name: 'first-update-failure', candidates:[row('a'),row('b')], failUpdate:0 },
 { name: 'partial-update-failure', candidates:[row('a'),row('b'),row('c')], failUpdate:1 },
];
async function record() {
 const out=[];
 for(const c of cases){
  const calls=[];let updates=0;
  const db={
   search:async(vector,limit,threshold)=>{calls.push({kind:'search',vector,limit,threshold});if(c.failSearch)throw new Error('synthetic failure');return c.candidates.map(entry=>({entry,score:0.9}));},
   update:async(id,patch)=>{calls.push({kind:'update',id,patch});if(updates++===c.failUpdate)throw new Error('synthetic failure');}
  };
  const result=await applyRetroactiveInterference(db,c.source??source,c.options??{});
  out.push({...c,source:c.source??source,options:c.options??{},calls,result});
 }
 return out;
}
try{
 const recorded=await record();assert.deepEqual(recorded,await record());
 writeFileSync(new URL('./golden/interference.json',import.meta.url),JSON.stringify({pin,now,sourcesSha256,cases:recorded},null,2)+'\n');
 console.log(`Recorded ${recorded.length} actual Node interference cases twice`);
}finally{Date.now=oldDateNow;}
