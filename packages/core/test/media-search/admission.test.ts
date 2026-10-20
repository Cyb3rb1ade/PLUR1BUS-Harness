import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardedMediaIndex } from '../../src/media-search/admission.ts';
import { FakePort } from './fakes.ts';
import { scope } from './helpers.ts';

const req=()=>({mediaId:'photo',kind:'image' as const,mime:'image/png',source:{bytes:new Uint8Array([1])},scope:scope()});
test('media units reserve before encode, settle conservatively on failure, and privacy flip refuses before reservation',async()=>{
 const events:string[]=[];let pinned=false; const base=new FakePort();
 base.indexImpl=async()=>{events.push('encode');return{state:'indexed',segments:1};};
 const guarded=guardedMediaIndex(base,{policy:()=>({local:false,model:'cloud',pinned}),budget:{reserve:async units=>{
  assert.equal(units.images,1);assert.equal(units.videoSeconds,0);events.push('reserve');
  return{settle:async()=>{events.push('settle');},release:async()=>{events.push('release');}};
 }}});
 await guarded.index(req()); assert.deepEqual(events,['reserve','encode','settle']);
 base.indexImpl=async()=>{events.push('encode');throw Error('provider failure');};
 await assert.rejects(guarded.index(req()),/provider failure/);assert.deepEqual(events.slice(-3),['reserve','encode','settle']);
 pinned=true; const count=events.length;await assert.rejects(guarded.index(req()),(e:any)=>e.error==='E_MEDIA_PRIVACY');assert.equal(events.length,count);
});
test('missing budget and refused reservations prevent encode; settlement failure stays visible',async()=>{
 const base=new FakePort();let encoded=0;base.indexImpl=async()=>{encoded++;return{state:'indexed',segments:1};};
 const policy=()=>({local:false,model:'cloud',pinned:false});
 await assert.rejects(guardedMediaIndex(base,{policy}).index(req()));assert.equal(encoded,0);
 await assert.rejects(guardedMediaIndex(base,{policy,budget:{reserve:async()=>{throw Error('hard limit');}}}).index(req()),/hard limit/);assert.equal(encoded,0);
 await assert.rejects(guardedMediaIndex(base,{policy,budget:{reserve:async()=>({settle:async()=>{throw Error('settlement failed');},release:async()=>{}})}}).index(req()),/settlement failed/);assert.equal(encoded,1);
});
test('localOnly flip during reservation releases unused units without encoding',async()=>{
 const base=new FakePort();let pinned=false,encoded=0,released=0,settled=0;
 base.indexImpl=async()=>{encoded++;return{state:'indexed',segments:1};};
 const port=guardedMediaIndex(base,{policy:()=>({local:false,model:'cloud',pinned}),budget:{reserve:async()=>{
  pinned=true;return{settle:async()=>{settled++;},release:async()=>{released++;}};
 }}});
 await assert.rejects(port.index(req()),(e:any)=>e.error==='E_MEDIA_PRIVACY');
 assert.equal(encoded,0);assert.equal(released,1);assert.equal(settled,0);
});
test('trusted video duration reserves rounded-up video seconds, never images or invalid durations', async()=>{
 const base=new FakePort();const reserved:{images:number;videoSeconds:number}[]=[];
 const port=guardedMediaIndex(base,{policy:()=>({local:false,model:'cloud',pinned:false}),budget:{reserve:async units=>{
  reserved.push(units);return{settle:async()=>{},release:async()=>{}};
 }}});
 await port.index({...req(),kind:'video',mime:'video/mp4',encodingVideoSeconds:2.25});
 assert.equal(reserved[0]!.images,0);assert.equal(reserved[0]!.videoSeconds,3);
 for(const duration of [0,-1,Number.NaN,Number.POSITIVE_INFINITY]) await assert.rejects(port.index({...req(),kind:'video',mime:'video/mp4',encodingVideoSeconds:duration}));
 assert.equal(reserved.length,1);
});
