import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpImageAdapter, OutputStore, JobRunner, FileJobPersistence, estimateCost, MediaError } from '../src/index.ts';
import { videoFormat, type VideoProcessor } from '../src/video.ts';
import { fakeServer, makeLeakyPng, SECRET_GPS } from './adapters-fixtures.ts';
const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(40)]);
const processor: VideoProcessor = async (input, output, poster, options) => {
  const bytes = await readFile(input); await writeFile(output, Buffer.concat([bytes, Buffer.from(options.prompt ?? '')]));
  await writeFile(poster, Buffer.from('poster')); return { durationSeconds: 4, width: 1280, height: 720, fps: 24, audio: false };
};
test('video magic bytes and seconds cost, unknown is explicit', () => {
  assert.equal(videoFormat(mp4), 'mp4');
  assert.equal(videoFormat(Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypqt  '), Buffer.alloc(12)])), 'mov');
  assert.equal(videoFormat(Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]), Buffer.from('webm')])), 'webm');
  assert.throws(() => videoFormat(Buffer.from('not video')), MediaError);
  const c = estimateCost({ kind: 'video', prompt: 'forest', durationSeconds: 4 }, { id: 'openai', model: 'unknown-configured-model' });
  assert.equal(c.usd, null); assert.equal(c.quantity, 4); assert.equal(c.unit, 'videoSecond');
});
test('streaming store publishes poster and measured fields, metadata defaults off; limits leave no output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-store-'));
  try {
    const store = new OutputStore(root, { videoProcessor: processor, maxVideoBytes: 4096 });
    const result = () => ({ files: [{ bytes: new Uint8Array(), format: 'mp4' as const, stream: (async function*(){ yield mp4.subarray(0,10); yield mp4.subarray(10); })() }], metadata: { adapter: 'fake', model: 'configured', durationMs: 1 } });
    const m = await store.put('off', { kind: 'video', prompt: 'private prompt', durationSeconds: 4 }, result());
    assert.equal(m.kind, 'video'); assert.equal(m.files[0]?.durationSeconds, 4); assert.equal(m.files[0]?.poster?.path, '0.poster.png');
    assert.equal((await readFile(join(root, 'off', '0.mp4'))).includes(Buffer.from('private prompt')), false);
    await store.put('on', { kind: 'video', prompt: 'private prompt', embedMetadata: true }, result());
    assert.equal((await readFile(join(root, 'on', '0.mp4'))).includes(Buffer.from('private prompt')), true);
    const small = new OutputStore(root, { maxVideoBytes: 10, videoProcessor: processor });
    await assert.rejects(small.put('large', { kind: 'video', prompt: 'x' }, result()), { code: 'too_large' });
    assert.equal(await small.get('large'), null); assert.equal((await readdir(root)).some(n => n.startsWith('.stage')), false);
    await assert.rejects(store.put('wrong', { kind: 'video', prompt: 'x' }, { ...result(), files: [{ bytes: Buffer.from('bad'), format: 'mp4' }] }), { code: 'invalid_response' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const id of ['openrouter','google','xai','replicate','fal'] as const) {
  test(`${id}: configured model, async progress, checkpoint, stream and existing jobs`, async () => {
    let base = ''; let polls = 0; const paths: string[] = [];
    const server = await fakeServer(async (req, res) => {
      paths.push(req.path!); res.setHeader('content-type','application/json');
      if (req.path === '/asset') { res.setHeader('content-type','video/mp4'); res.end(mp4); return; }
      if (req.method === 'POST') { res.end(JSON.stringify(id === 'google' ? {name:'operations/op'} : id === 'openrouter' || id === 'replicate' ? {id:'op',status:'queued'} : {request_id:'op'})); return; }
      if (id === 'replicate' && req.path === '/models/owner/configured') { res.end(JSON.stringify({latest_version:{openapi_schema:{components:{schemas:{Input:{properties:{prompt:{type:'string'},duration:{type:'number'}}}}}}}})); return; }
      if (req.path?.endsWith('/content')) { res.setHeader('content-type','video/mp4'); res.end(mp4); return; }
      if (id === 'openrouter' && req.path === '/videos/models') { res.end(JSON.stringify({data:[{id:'configured-video-model',supported_durations:[4]}]})); return; }
      polls++;
      if (polls === 1) { res.end(JSON.stringify(id === 'google' ? {done:false} : {status: id === 'fal' ? 'IN_PROGRESS' : 'running',progress:20})); return; }
      const done = id === 'google' ? {done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:base+'/asset'}}]}}} : id === 'openrouter' ? {status:'completed'} : id === 'xai' ? {status:'done',video:{url:base+'/asset'}} : id === 'replicate' ? {status:'succeeded',output:base+'/asset'} : req.path?.endsWith('/status') ? {status:'COMPLETED'} : {video:{url:base+'/asset'}};
      res.end(JSON.stringify(done));
    }); base = server.url;
    const root = await mkdtemp(join(tmpdir(), 'video-job-'));
    try {
      const adapter = new HttpImageAdapter({ id, model: id === 'replicate' ? 'owner/configured' : 'configured-video-model', baseUrl:base, video: { textToVideo:true, imageToVideo:true, videoToVideo: id !== 'openrouter', durationSeconds:[1,60], inputSchema:{prompt:{type:'string'},duration:{type:'number'}} }, pollWait: async (_ms,s) => { s.throwIfAborted(); }, videoProcessor:processor });
      const runner = new JobRunner(new FileJobPersistence(join(root,'jobs')), new OutputStore(join(root,'outputs'),{videoProcessor:processor}), [adapter]);
      const job = await runner.enqueue(id,{kind:'video',prompt:'forest',durationSeconds:4}); await runner.run(job.id);
      const finished = await runner.persistence.get(job.id); assert.equal(finished?.state,'succeeded'); assert.equal(finished?.checkpoint?.model,adapter.model); assert.equal(finished?.output?.kind,'video'); assert.ok(polls >= 2);
      assert.ok(paths.some(p => p.includes(id === 'google' ? ':predictLongRunning' : id === 'xai' ? 'videos/generations' : id === 'openrouter' ? '/videos' : id === 'replicate' ? '/predictions' : 'configured-video-model')));
    } finally { await server.close(); await rm(root,{recursive:true,force:true}); }
  });
}

test('retired OpenAI video is unavailable even when configured', async () => { const a = new HttpImageAdapter({id:'openai',model:'configured',video:{textToVideo:true,imageToVideo:true,videoToVideo:true}}); assert.equal(a.capabilities().video?.textToVideo,false); await assert.rejects(a.generate({kind:'video',prompt:'x'}),{code:'unsupported_parameter'}); });

for (const id of ['google','xai','replicate','fal','openrouter'] as const) {
  for (const scenario of ['auth','refusal','retry','cancel','mime','oversize'] as const) {
    test(`${id} contract: ${scenario}`, async () => {
      const controller = new AbortController(); let posts = 0, sleeps = 0, cancels = 0;
      let base = '';
      const server = await fakeServer((req,res)=>{
        res.setHeader('content-type','application/json');
        if (req.path === '/asset' || req.path.endsWith('/content')) { res.setHeader('content-type','video/mp4'); res.end(scenario === 'mime' ? 'not-video' : mp4); return; }
        if (req.path.includes('/cancel')) { cancels++; res.end('{}'); return; }
        if (req.path === '/videos/models') {res.end(JSON.stringify({data:[{id:'configured'}]}));return;}
        if (id === 'replicate' && req.path === '/models/owner/configured') {res.end(JSON.stringify({latest_version:{openapi_schema:{components:{schemas:{Input:{properties:{prompt:{type:'string'}}}}}}}}));return;}
        if (req.method === 'POST') {
          posts++;
          if (scenario === 'auth') {res.writeHead(401);res.end('{"error":"bad key synthetic"}');return;}
          if (scenario === 'refusal') {res.writeHead(400);res.end('{"error":"content policy"}');return;}
          if (scenario === 'retry' && posts === 1) {res.writeHead(429,{'retry-after':'2'});res.end('{}');return;}
          res.end(JSON.stringify(id === 'google' ? {name:'operations/op'} : ['replicate','openrouter'].includes(id) ? {id:'op'} : {request_id:'op'}));return;
        }
        res.end(JSON.stringify(id === 'google' ? {done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:base+'/asset'}}]}}} : id === 'replicate' ? {status:'succeeded',output:base+'/asset'} : id === 'fal' ? req.path.endsWith('/status') ? {status:'COMPLETED'} : {video:{url:base+'/asset'}} : id === 'openrouter' ? {status:'completed',usage:{cost:0.25}} : {status:'done',video:{url:base+'/asset'}}));
      }); base=server.url;
      const root=await mkdtemp(join(tmpdir(),'video-contract-'));
      try {
        const a=new HttpImageAdapter({id,model:id === 'replicate' ? 'owner/configured' : 'configured',baseUrl:base,video:{textToVideo:true,imageToVideo:false,videoToVideo:false,inputSchema:{prompt:{type:'string'}}},retry:{sleep:async(ms,s)=>{assert.equal(ms,2000);s.throwIfAborted();sleeps++;}},pollWait:async(_ms,s)=>{if(scenario==='cancel') controller.abort();s.throwIfAborted();}});
        const run=async()=>{const result=await a.generate({kind:'video',prompt:'x'}, {signal:controller.signal});return new OutputStore(root,{videoProcessor:processor,maxVideoBytes:scenario==='oversize'?10:4096}).put('out',{kind:'video',prompt:'x'},result);};
        const code=scenario==='auth'?'backend_unavailable':scenario==='refusal'?'content_policy':scenario==='cancel'?'cancelled':scenario==='mime'?'invalid_response':scenario==='oversize'?'too_large':null;
        if(code) await assert.rejects(run(),{code}); else {const m=await run();assert.equal(posts,2);assert.equal(sleeps,1); if(id==='openrouter')assert.equal(m.metadata.costUsd,0.25);}
        if(scenario==='cancel' && ['replicate','fal'].includes(id))assert.equal(cancels,1);
      } finally {await server.close();await rm(root,{recursive:true,force:true});}
    });
  }
}
test('configured table estimate is per second and resolution',()=>{
  const cost=estimateCost({kind:'video',prompt:'x',durationSeconds:4,resolution:'720p'},{id:'google',model:'veo-3.1-generate-preview'});assert.equal(cost.usd,1.6);
});

test('video requests enforce kind, positive duration, count, FPS, container and input limit', async()=>{
  const {validateRequest,AdapterRegistry}=await import('../src/index.ts');
  const base={kind:'video' as const,prompt:'x'};
  for(const bad of [{durationSeconds:0},{durationSeconds:NaN},{n:2},{fps:0},{fps:121},{format:'png'},{videoFormat:'avi'},{steps:1},{mask:{bytes:mp4,format:'png'}}]) assert.throws(()=>validateRequest({...base,...bad} as any),MediaError);
  assert.throws(()=>validateRequest({prompt:'x',durationSeconds:4}),MediaError);
  assert.throws(()=>validateRequest({...base,referenceVideo:{bytes:new Uint8Array(50*1024*1024+1),format:'mp4'}}),{code:'too_large'});
  const registry=new AdapterRegistry([{id:'openai',model:'image'},{id:'xai',model:'configured',video:{textToVideo:true,imageToVideo:true,videoToVideo:true}}]);
  assert.equal(registry.selectVideo('videoToVideo').id,'xai');assert.throws(()=>new AdapterRegistry([]).selectVideo('textToVideo'),MediaError);
  await assert.rejects(registry.generate(base,['openai']),{code:'backend_unavailable'});
});

test('video profile refuses undeclared ranges/parameters before any request',async()=>{
 const a=new HttpImageAdapter({id:'xai',model:'configured',baseUrl:'http://127.0.0.1:1',video:{textToVideo:true,imageToVideo:false,videoToVideo:false,durationSeconds:[1,5],resolutions:['720p'],aspects:['16:9'],fps:[24],audio:false}});
 for(const extra of [{durationSeconds:6},{resolution:'4k'},{aspect:'1:1'},{fps:30},{audio:true},{referenceVideo:{bytes:mp4,format:'mp4'}},{size:{width:1280,height:720}},{referenceImages:[{bytes:mp4,format:'png'}]}]) await assert.rejects(a.generate({kind:'video',prompt:'x',...extra} as any),{code:'unsupported_parameter'});
 const no=new HttpImageAdapter({id:'xai',model:'configured'});await assert.rejects(no.generate({kind:'video',prompt:'x'}),{code:'unsupported_parameter'});
});

test('video config overlay preserves host secrets handles and never invents a model',async()=>{
 const {applyVideoSettings}=await import('../src/index.ts');
 const defs=[{id:'xai' as const,model:'configured-image',secretRef:'synthetic-handle'}];
 const out=applyVideoSettings(defs,{video:{adapters:{xai:{model:'configured-video',textToVideo:true,imageToVideo:true,videoToVideo:true}}}});
 assert.equal(out[0]!.model,'configured-image');assert.equal(out[0]!.secretRef,'synthetic-handle');assert.equal((out[0] as any).video.model,'configured-video');assert.equal((defs[0] as any).video,undefined);
 assert.equal((applyVideoSettings(defs,undefined)[0] as any).video,undefined);
});

for(const id of ['google','xai','replicate','fal'] as const) test(`${id}: upload sanitized reference video through existing edit, resume without resubmission`,async()=>{
 let base='';const server=await fakeServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.path==='/asset'){res.end(mp4);return;}
  if(id==='replicate' && req.path==='/models/owner/configured'){res.end(JSON.stringify({latest_version:{openapi_schema:{components:{schemas:{Input:{properties:{prompt:{type:'string'},video_url:{type:'string'}}}}}}}}));return;}
  if(req.method==='POST'){
   const body=JSON.parse(req.body);
   if(id==='google')assert.ok(body.instances[0].video.inlineData.data);
   else if(id==='xai'){assert.equal(req.path,'/videos/edits');assert.ok(body.video.url.startsWith('data:video/mp4;'));}
   else assert.ok((id==='fal'?body:body.input).video_url.startsWith('data:video/mp4;'));
   res.end(JSON.stringify(id==='google'?{name:'operations/op'}:id==='replicate'?{id:'op'}:{request_id:'op'}));return;
  }
  res.end(JSON.stringify(id==='google'?{done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:base+'/asset'}}]}}}:id==='replicate'?{status:'succeeded',output:base+'/asset'}:id==='fal'?req.path.endsWith('/status')?{status:'COMPLETED'}:{video:{url:base+'/asset'}}:{status:'done',video:{url:base+'/asset'}}));
 });base=server.url;
 try{
  const a=new HttpImageAdapter({id,model:id==='replicate'?'owner/configured':'configured',baseUrl:base,video:{textToVideo:true,imageToVideo:true,videoToVideo:true,inputSchema:{prompt:{type:'string'},video_url:{type:'string'}}},pollWait:async(_ms,s)=>s.throwIfAborted(),videoProcessor:processor});
  let checkpoint:any;
  await a.edit({kind:'video',prompt:'snow',referenceVideo:{bytes:mp4,format:'mp4'}},{onCheckpoint:async t=>{checkpoint=t;}});
  const posts=server.calls.filter(c=>c.method==='POST').length;
  await a.resume({kind:'video',prompt:'snow'},{resume:checkpoint});assert.equal(server.calls.filter(c=>c.method==='POST').length,posts);
  await assert.rejects(a.resume({kind:'video',prompt:'snow'},{resume:{id:'../escape',model:a.model}}),{code:'unsupported_parameter'});
 }finally{await server.close();}
});
test('job abort during streaming leaves cancelled state and no published/staged video',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stream-cancel-'));let signal:AbortSignal|undefined;
 const a={id:'fake',capabilities:()=>({generate:true,edit:false,inpaint:false}),async generate(_r:any,c:any){signal=c.signal;return {files:[{bytes:new Uint8Array(),format:'mp4' as const,stream:(async function*(){yield mp4; await runner.cancel(job.id);signal!.throwIfAborted();})()}],metadata:{adapter:'fake',model:'fake',durationMs:0}};},async edit(){throw new Error('unused');}};
 const store=new OutputStore(join(root,'outputs'),{videoProcessor:processor});const runner=new JobRunner(new FileJobPersistence(join(root,'jobs')),store,[a]);const job=await runner.enqueue('fake',{kind:'video',prompt:'x',referenceVideo:{bytes:mp4,format:'mp4'}});
 try{assert.deepEqual((await runner.persistence.get(job.id))?.request.referenceVideo?.bytes,mp4);await runner.run(job.id);assert.equal((await runner.persistence.get(job.id))?.state,'cancelled');assert.equal(await store.get(job.id),null);assert.equal((await readdir(store.root)).some(n=>n.startsWith('.stage')),false);}finally{await rm(root,{recursive:true,force:true});}
});

for(const id of ['google','xai','replicate','fal','openrouter'] as const) test(`${id}: image-to-video strips GPS before provider upload`,async()=>{
 let base='';const server=await fakeServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.path==='/videos/models'){res.end(JSON.stringify({data:[{id:'configured'}]}));return;}
  if(id==='replicate' && req.path==='/models/owner/configured'){res.end(JSON.stringify({latest_version:{openapi_schema:{components:{schemas:{Input:{properties:{prompt:{type:'string'},image_url:{type:'string'}}}}}}}}));return;}
  if(req.method==='POST'){
   const b=JSON.parse(req.body);const data=id==='google'?b.instances[0].image.inlineData.data:id==='xai'?b.image.url:id==='openrouter'?b.frame_images[0].image_url.url:id==='fal'?b.image_url:b.input.image_url;
   assert.equal(Buffer.from(data.includes(',')?data.split(',')[1]:data,'base64').includes(Buffer.from(SECRET_GPS)),false);
   res.end(JSON.stringify(id==='google'?{name:'operations/op'}:['replicate','openrouter'].includes(id)?{id:'op'}:{request_id:'op'}));return;
  }
  res.end(JSON.stringify(id==='google'?{done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:base+'/asset'}}]}}}:id==='replicate'?{status:'succeeded',output:base+'/asset'}:id==='fal'?req.path.endsWith('/status')?{status:'COMPLETED'}:{video:{url:base+'/asset'}}:id==='openrouter'?{status:'completed'}:{status:'done',video:{url:base+'/asset'}}));
 });base=server.url;
 try{const a=new HttpImageAdapter({id,model:id==='replicate'?'owner/configured':'configured',baseUrl:base,video:{textToVideo:true,imageToVideo:true,videoToVideo:true,inputSchema:{prompt:{type:'string'},image_url:{type:'string'}}},pollWait:async(_ms,s)=>s.throwIfAborted()});await a.generate({kind:'video',prompt:'animate',referenceImages:[{bytes:makeLeakyPng(),format:'png'}]});assert.equal(server.calls.filter(c=>c.method==='POST').length,1);}finally{await server.close();}
});
