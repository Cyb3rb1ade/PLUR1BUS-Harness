// C3 import identity, persisted digests, ledger indexing and durable append (actual Node).
import assert from 'node:assert/strict';
import {createHash}from'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync}from'node:fs';
import {tmpdir}from'node:os';import path from'node:path';import {pathToFileURL}from'node:url';
const root=process.env.PLUR1BUS_ENGINE_SRC;assert.equal(process.version,'v24.21.0');assert.ok(root);
const source=JSON.parse(readFileSync(new URL('./import-sources.json',import.meta.url),'utf8'));
for(const[file,hash]of Object.entries(source.sha256))assert.equal(createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex'),hash);
const load=file=>import(pathToFileURL(path.join(root,file)));
const {importCardId}=await load('engine/memory-ops/import-id.js');const {importRowDigest}=await load('engine/memory-ops/import-digest.js');const {createImportLedger}=await load('engine/memory-ops/import-ledger.js');
function record(){
 const ids=['key',' k ','é','😀','e\u0301','x'.repeat(256),'a\0b'].flatMap(key=>['agent','Agent','_a'].map(agent=>({agent,key,id:importCardId(agent,key)})));
 const digestRows=[{}, {text:'synthetic',summary:'summary',scope:'agent-private',agentId:'agent'},
 ...[0,-0,0.699999988079071,0.7000000001,0.0000005,-0.0000005,1e-7,1e21,1e22,9007199254740991,'0x10','0o10','0b10','-0x10',' 0.7 ','\ufeff0.7\ufeff',null,true,'Infinity',-1.0000005,4503599627370495.5,[],[1],[null],[1,2],{}].map(value=>({text:'numbers',importance:value,updatedAt:value,validUntil:value,neverForget:value})),
 ...[true,1,'true',false,0,'1','false',null].map(value=>({text:'boolean',neverForget:value})),
 {text:'é😀\nquote"',summary:'escape\t',category:'other',vector:[9,8],retrievalCount:800,lastRetrievedAt:900},
 {text:'é😀\nquote"',summary:'escape\t',category:'other',vector:[0,1],retrievalCount:0,lastRetrievedAt:0},
 ];const digests=digestRows.map(row=>({rowJson:JSON.stringify(row),digest:importRowDigest(row)}));
 for(const row of [{text:'legacy\ud800',summary:'\udfff'}, {text:1e21,summary:[null,'a',null,1e-7],category:{}}, {text:'same',importance:0.699999988079071}, {text:'same',importance:0.7}]) digests.push({rowJson:JSON.stringify(row),digest:importRowDigest(row)});
 const a={v:1,idempotencyKey:'a',cardId:'card-a',importedAt:1,sourceRef:'fixture-a;run=run-1',opaque:'retained'};const b={v:1,idempotencyKey:'b',cardId:'card-b',importedAt:2,sourceRef:'fixture-b'};
 const definitions=[
 {name:'empty',initial:'',append:[]}, {name:'torn-append',initial:'{torn',append:[a]},
 {name:'foreign-malformed',initial:['{bad',JSON.stringify({...a,v:2}),JSON.stringify({...a,idempotencyKey:7}),JSON.stringify(a)].join('\n'),append:[]},
 {name:'unimport-frees-key',initial:[a,b].map(JSON.stringify).join('\n'),append:[{kind:'unimported',idempotencyKey:'a',cardId:'card-a',importRunId:'run-1',at:3}]},
 {name:'reimport-reclaims-key',initial:JSON.stringify(a),append:[{kind:'unimported',idempotencyKey:'a',cardId:'card-a',importRunId:'run-1',at:3},{...a,importedAt:4,importRunId:'run-2',backfilled:true,digest:{content:'0123456789abcdef',binding:'fedcba9876543210',meta:'0000000000000000'}}]},
 {name:'unknown-future-kind',initial:JSON.stringify(a),append:[],extraLines:[{...b,kind:'future'}]},
 {name:'same-key-other-card',initial:[a,{...b,idempotencyKey:'a'}].map(JSON.stringify).join('\n'),append:[{kind:'unimported',idempotencyKey:'a',cardId:'card-a',importRunId:'run-1',at:3}]},
 ];const ledgers=[];
 for(const def of definitions){const work=mkdtempSync(path.join(tmpdir(),'rx3-import-ledger-'));try{
  const baseDbPath=path.join(work,'store');mkdirSync(path.join(baseDbPath,'_imports'),{recursive:true});const file=path.join(baseDbPath,'_imports/agent.jsonl');writeFileSync(file,def.initial+(def.extraLines?'\n'+def.extraLines.map(JSON.stringify).join('\n'):''));
  const ledger=createImportLedger({baseDbPath});for(const row of def.append)ledger.append('agent',row);
  const lines=ledger.readLines('agent');const index=ledger.load('agent');ledgers.push({...def,lines,index:Object.fromEntries(Object.entries(index).map(([name,map])=>[name,Object.fromEntries(map)]))});
 }finally{rmSync(work,{recursive:true,force:true});}}
 return{ids,digests,ledgers};
}
const result=record();assert.deepEqual(record(),result);writeFileSync(new URL('./golden/import-primitives.json',import.meta.url),JSON.stringify({recordedFrom:{source,node:process.version},...result},null,2)+'\n');console.log(`Recorded ${result.ids.length} IDs, ${result.digests.length} digests, ${result.ledgers.length} ledger cases twice`);
