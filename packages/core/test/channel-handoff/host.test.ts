import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeRig, OWNER } from '../channels/switchboard-rig.ts';
import { ChannelHandoff } from '../../src/channel-handoff/service.ts';
import { tempDir } from '../helpers/temp-dir.ts';
test('all seven channel host fakes share own-DM /web, no unlinked or group links and no token logging',async()=>{
 const ids=['telegram','discord','matrix','buzz','slack','signal','email'];let handoff:ChannelHandoff;
 const r=makeRig({ids,switchboard:{observed:(msg,person,id)=>handoff.observe(msg,person,id),command:async(msg,person,send)=>{if(msg.text!=='/web')return false;let text;try{text=handoff.issueMessage(msg,person);}catch{text='unavailable';}await send({chatId:msg.chatId,text});return true;}}});
 const human=r.identity.createHuman({displayName:'Pat'},OWNER);
 handoff=new ChannelHandoff({path:join(tempDir('handoff-host-'),'handoff.sqlite'),store:()=>r.store,identity:()=>r.identity,resolve:id=>({userId:id,kind:'person',role:'owner'}),clock:()=>r.clock.now(),audit:{append(){}},agentId:()=> 'main',baseUrl:()=> 'https://web.example'});
 try{
  for(const id of ids){r.config.set(id,{enabled:true,...(id==='matrix'?{homeserverUrl:'https://hs.test',userId:'@bot:hs.test'}:{}),...(id==='signal'?{account:'+15550001111'}:{}),...(id==='email'?{address:'bot@example.test'}:{})});const secrets=(v:any)=>{for(const [key,value]of Object.entries(v)){if(key.endsWith('Secret')&&typeof value==='string')r.secrets.put(value,'test-secret');else if(value&&typeof value==='object')secrets(value);}};secrets((r.config.current().channels as any)[id]);const p=r.identity.startPairing({humanId:human.id,channel:id},OWNER);const c=r.identity.claim({code:p.code,identity:{channel:id,accountId:'bot',userId:'sender'}});r.identity.confirm({pairingId:c.pairingId,approve:true},OWNER);r.clock.t+=900001;}
  await r.switchboard.start();await r.clock.advance(0);
  // The service caps outstanding links per person. Consume each before issuing the next.
  for(const id of ids){const a=r.adapter(id);await a.inbound({chatId:'dm-'+id,accountId:'bot',senderId:'sender',text:'hello'});await a.inbound({chatId:'dm-'+id,accountId:'bot',senderId:'sender',text:'/web'});const url=a.sent.at(-1)!.text;assert.match(url,/^https:\/\/web.example\/#\/chat\/handoff\//);const token=url.split('/').at(-1)!;assert.ok(!JSON.stringify(r.logs).includes(token));handoff.redeem(token,human.id);await a.inbound({chatId:'group-'+id,accountId:'bot',senderId:'sender',chatKind:'group',addressed:true,text:'/web'});assert.equal(a.sent.at(-1)!.text,'unavailable');await a.inbound({chatId:'stranger-'+id,accountId:'bot',senderId:'stranger',text:'/web'});assert.doesNotMatch(a.sent.at(-1)!.text,/https:/);}
  assert.equal(handoff.list(human.id).sessions.length,7);
 }finally{await r.switchboard.stop();handoff.close();r.close();}
});
