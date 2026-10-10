import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {outputAttachment,TELEGRAM_VIDEO_MAX_BYTES} from '../src/outputs.ts';
import type {Manifest} from '../../media/src/store.ts';
test('Telegram stored MP4 video, WebM/MOV document, size hint and destination rights',async()=>{
 const root=await mkdtemp(join(tmpdir(),'telegram-video-')), id='00000000-0000-4000-8000-000000000001';
 try {
  await mkdir(join(root,id));const bytes=Buffer.from('synthetic stored bytes');const hash=createHash('sha256').update(bytes).digest('hex');
  for(const format of ['mp4','webm','mov']){
   await writeFile(join(root,id,`0.${format}`),bytes);
   const manifest={kind:'video',files:[{path:`0.${format}`,format,bytes:bytes.length,sha256:hash}]} as Manifest;
   const port={store:{root,get:async()=>manifest},authorize:async()=>true};
   const out=await outputAttachment(port,id,'42');assert.equal(out.kind,format==='mp4'?'video':'document');assert.equal(out.mimeType,format==='mov'?'video/quicktime':`video/${format}`);
   await assert.rejects(outputAttachment({...port,authorize:async()=>false},id,'42'),/denied/);
   manifest.files[0]!.sha256='wrong';await assert.rejects(outputAttachment(port,id,'42'),/integrity/);
   manifest.files[0]!.bytes=TELEGRAM_VIDEO_MAX_BYTES+1;await assert.rejects(outputAttachment(port,id,'42'),/download it with/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('oversized authorized stored video sends a hint through sendOutput without uploading bytes',async()=>{
 const {TelegramChannel,MemoryOffsetStore}=await import('../src/index.ts');const requests:string[]=[];
 const id='00000000-0000-4000-8000-000000000001';
 const channel=new TelegramChannel({tokenSecret:'fixture',secrets:{reveal:async()=> '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop'},allowlist:[42],offsetStore:new MemoryOffsetStore(),mode:'webhook',webhook:{url:'https://fixture.invalid/webhook',secret:'synthetic'},outputs:{authorize:async()=>true,store:{root:'/not-read',get:async()=>({kind:'video',files:[{path:'0.mp4',format:'mp4',bytes:TELEGRAM_VIDEO_MAX_BYTES+1,sha256:'not-read'}]} as Manifest)}},fetch:async(url,init)=>{const method=String(url).split('/').at(-1)!;requests.push(method);if(method==='sendMessage')assert.ok(JSON.parse(String(init?.body)).text.includes('Retrieve output'));return new Response(JSON.stringify({ok:true,result:method==='getMe'?{id:123456789,username:'fixture'}:method==='sendMessage'?{message_id:1}:true}),{headers:{'content-type':'application/json'}});}});
 try{await channel.start();assert.deepEqual(await channel.sendOutput('42',id),['1']);assert.ok(requests.includes('sendMessage'));assert.equal(requests.includes('sendVideo'),false);}finally{await channel.stop();}
});
