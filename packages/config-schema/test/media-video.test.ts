import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults,validate,restartClassOf} from '../src/index.ts';
test('video config has no model defaults, embedding off, core restart and explicit profiles',()=>{
 const config=defaults();assert.deepEqual(config.media?.video?.adapters,{});assert.equal(config.media?.video?.embedMetadata,false);assert.equal(config.media?.video?.maxBytes,512*1024*1024);
 assert.equal(restartClassOf('media.video.adapters.google.model'),'core');
 const ok=validate({...config,media:{video:{adapters:{google:{model:'configured-video',textToVideo:true,durationSeconds:[4,8]}}}}});assert.ok(ok.ok);
 const no=validate({...config,media:{video:{adapters:{google:{textToVideo:true}}}}});assert.equal(no.ok,false);
});
