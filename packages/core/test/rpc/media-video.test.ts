import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaSurface } from '../../src/rpc/media-surface.ts';
import { guardMethods } from '../../src/rbac/guard.ts';
import { createCallBudget, PriceBook } from '../../src/budget/index.ts';
import { OutputStore, type ImageAdapter } from '../../../media/src/index.ts';
const ctx = {requestId:'r',connectionId:'c',signal:new AbortController().signal};
test('video RPC reuses authorization, measures seconds and supports bounded ranges and video edit refs',async () => {
  const home = await mkdtemp(join(tmpdir(),'rpc-video-'));
  const budget = createCallBudget({path:join(home,'budget.sqlite'),clock:{now:()=>1000},prices:new PriceBook([{version:'fake',effectiveFrom:0,models:{fake:{input:0,output:0,media:{videoSecond:{'720p':100}}}}}])});
  let references = false;
  const adapter: ImageAdapter = {id:'fake',model:'fake',capabilities:()=>({generate:true,edit:true,inpaint:false,video:{textToVideo:true,imageToVideo:true,videoToVideo:true}}),async generate(r) {
    references = !!r.referenceVideo;
    return {files:[{bytes:Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(40)]),format:'mp4'}],metadata:{adapter:'fake',model:'fake',durationMs:1}};
  },async edit(r,c){return this.generate(r,c);}};
  const surface = createMediaSurface({home,adapters:[adapter],store:new OutputStore(join(home,'outputs'),{videoProcessor:async(i,o,p)=>{await writeFile(o,await readFile(i));await writeFile(p,Buffer.from('poster'));return {durationSeconds:4,width:1280,height:720,fps:24,audio:false};}}),budget,signal:ctx.signal,policy:async()=>{},notify:()=>{}});
  const methods = guardMethods(surface.methods,{resolve:()=>({userId:'owner',role:'owner',kind:'person'}),now:()=>0});
  try {
    const q = await methods['media.generate']!({agentId:'main',kind:'video',request:{prompt:'forest',durationSeconds:8,resolution:'720p'}},ctx) as {jobId:string}; await surface.close();
    const job = await methods['media.job.get']!({id:q.jobId},ctx) as any; assert.equal(job.state,'succeeded'); assert.equal(job.kind,'video');
    const out = await methods['media.output.get']!({id:q.jobId,file:0,offset:0,length:12},ctx) as any;
    assert.equal(out.mimeType,'video/mp4'); assert.equal(out.nextOffset,12); assert.equal(Buffer.from(out.data,'base64').length,12);
    assert.equal(out.manifest.files[0].durationSeconds,4);
    const edit = await methods['media.edit']!({agentId:'main',kind:'video',request:{prompt:'snow',referenceVideoId:q.jobId,resolution:'720p'}},ctx) as any; await surface.close(); assert.ok(edit.jobId); assert.ok(references);
    await assert.rejects(methods['media.generate']!({agentId:'main',kind:'video',request:{kind:'image',prompt:'x'}},ctx),{error:'E_INVALID_PARAMS'});
  } finally {await surface.close();budget.close();await rm(home,{recursive:true,force:true});}
});

test('video schema is additive and bounded on existing methods',async()=>{
 const {validateParams}=await import('../../../rpc-schema/src/index.ts');
 assert.equal(validateParams('media.generate',{agentId:'main',kind:'video',request:{prompt:'forest',durationSeconds:4,resolution:'720p',fps:24,audio:true}}).ok,true);
 assert.equal(validateParams('media.edit',{agentId:'main',request:{kind:'video',prompt:'snow',referenceVideoId:'00000000-0000-4000-8000-000000000001'}}).ok,true);
 assert.equal(validateParams('media.output.get',{id:'00000000-0000-4000-8000-000000000001',file:0,offset:0,length:4*1024*1024}).ok,true);
 assert.equal(validateParams('media.output.get',{id:'00000000-0000-4000-8000-000000000001',file:0,offset:0,length:4*1024*1024+1}).ok,false);
});
