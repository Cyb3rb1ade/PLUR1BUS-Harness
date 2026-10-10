import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processVideo, sanitizeVideo, OutputStore } from '../src/index.ts';
const exec = promisify(execFile);
for(const format of ['mp4','mov','webm'] as const) test(`native synthetic ${format}: clean remux, poster, prompt on/off`,async t=>{
  try {await exec('ffmpeg',['-version']);await exec('ffprobe',['-version']);}catch{t.skip('ffmpeg/ffprobe unavailable; portable store tests use injected processor');return;}
  const root=await mkdtemp(join(tmpdir(),'native-video-'));
  try{
    const source=join(root,`source.${format}`);
    await exec('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=24','-t','0.25','-c:v',format==='webm'?'libvpx-vp9':'mpeg4','-metadata','comment=GPS-SECRET-device','-y',source]);
    const bytes=await readFile(source);
    const clean=await sanitizeVideo(bytes);assert.equal(Buffer.from(clean.bytes).includes(Buffer.from('GPS-SECRET-device')),false);
    const store=new OutputStore(join(root,'outputs'));
    for(const embedMetadata of [false,true]){
      const manifest=await store.put(embedMetadata?'on':'off',{kind:'video',prompt:'my private prompt',embedMetadata},{files:[{bytes,format}],metadata:{adapter:'synthetic',model:'configured',durationMs:0}});
      const path=join(store.root,manifest.id,manifest.files[0]!.path);const output=await readFile(path);
      assert.equal(output.includes(Buffer.from('GPS-SECRET-device')),false);assert.equal(output.includes(Buffer.from('my private prompt')),embedMetadata);
      assert.equal(manifest.files[0]?.width,64);assert.equal(manifest.files[0]?.height,64);assert.ok(manifest.files[0]!.durationSeconds!>0);
      const poster=await readFile(join(store.root,manifest.id,manifest.files[0]!.poster!.path));assert.deepEqual(poster.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
      if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
    }
    const ac=new AbortController();ac.abort();await assert.rejects(processVideo(source,join(root,'x.mp4'),join(root,'x.png'),{format,signal:ac.signal}));
  }finally{await rm(root,{recursive:true,force:true});}
});
