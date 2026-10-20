import { defaults } from '@plur1bus/config-schema';
import { createMediaSearchSurface } from '../../src/rpc/media-search-surface.ts';
import { guardMethods } from '../../src/rbac/guard.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineMediaIndex } from '../../src/media-search/engine-adapter.ts';
import { scope } from './helpers.ts';

test('Engine 1.19 maps trusted agent/workspace scope, namespaces IDs and filters foreign hits', async () => {
  const calls: any[] = [];
  const media: any = {
    index: async (r: any) => { calls.push(r); return { state: 'indexed', segments: 1 }; },
    search: async (r: any) => { if(r.likeMediaId && r.likeMediaId!==calls[0].mediaId) throw Error('unknown seed in this agent scope'); calls.push(r); return [{mediaId:calls[0].mediaId,kind:'image',score:1},{mediaId:'foreign',kind:'image',score:1}]; },
    remove: async(id: string)=>{calls.push(id);},setCaption:async(...r:any[])=>{calls.push(r);},
    status: () => ({enabled:true,provider:'local-transformers',model:'google/embeddinggemma-2',dim:768,fingerprint:'x',counts:{indexed:1,pending:0,failed:0,unsupported:0},backfill:{state:'completed',done:1,total:1,startedAt:1000}}),
    backfill:{start:async()=>{},pause:async()=>{},resume:async()=>{},cancel:async()=>{}}
  };
  const alice = scope('alice');
  const idx = new EngineMediaIndex(media, { scopeOfMedia: async () => alice });
  await idx.index({ mediaId:'photo',kind:'image',mime:'image/png',source:{bytes:new Uint8Array([1])},scope:alice,caption:'a green square',captionSource:'user' });
  assert.notEqual(calls[0].mediaId,'photo');
  assert.deepEqual(calls[0].scope,{agentId:'alice',scope:'agent-private'});
  assert.equal(calls[0].caption,'a green square');
  assert.deepEqual((await idx.search({text:'green',limit:2,scope:alice})).map(h=>h.mediaId),['photo']);
  assert.deepEqual(await idx.search({text:'green',limit:2,scope:scope('bob')}),[]);
  const beforeSeed = calls.length;
  assert.deepEqual(await idx.search({likeMediaId:'photo',limit:2,scope:scope('bob')}),[]);
  assert.equal(calls.length,beforeSeed);
  assert.equal((await idx.search({likeMediaId:'photo',limit:2,scope:alice}))[0]!.mediaId,'photo');
  const surface = createMediaSearchSurface({index:()=>idx,config:()=>defaults(),scopeOf:()=>[alice,scope('bob')],readable:async()=>true,editable:async()=>true,
    backfill:{pause:async()=>{},resume:async()=>{},reindex:async()=>{}}});
  const methods=guardMethods(surface.methods,{resolve:()=>({userId:'owner',role:'owner',kind:'person'}),now:()=>1,audit:memoryAuditSink()});
  const result=await methods['media.search']!({likeMediaId:'photo'},{requestId:'r',connectionId:'c',signal:new AbortController().signal}) as {hits:{mediaId:string}[]};
  assert.deepEqual(result.hits.map(h=>h.mediaId),['photo'],'a human seed query keeps agent A results and never queries the seed in agent B');
  await idx.setCaption('photo','changed','user'); await idx.remove('photo');
  assert.deepEqual(calls.at(-2),[calls[0].mediaId,'changed','user']);
  assert.equal(calls.at(-1),calls[0].mediaId);
  const status=await idx.status();
  assert.equal(status.backfill.state,'done'); assert.equal(status.backfill.startedAt,'1970-01-01T00:00:01.000Z');
});
