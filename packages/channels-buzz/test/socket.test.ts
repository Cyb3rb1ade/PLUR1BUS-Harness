import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuzzChannel, MemorySeenStore } from '../src/index.ts';
import { generateSecretKey, getPublicKey, finalizeEvent, wrapEvent } from '../src/nostr.ts';
import { fakeRelay } from './fake-relay.ts';
test('real pinned WebSocket permits late metadata and ACK during an active inbound turn without sending Authorization', async()=>{
 const relay=await fakeRelay(), bot=generateSecretKey(),peer=generateSecretKey();
 const pub=getPublicKey(bot), other=getPublicKey(peer);
 let completed=false;
 const ch=new BuzzChannel({relays:[relay.url],senderAllowlist:[other]}, {seen:new MemorySeenStore(), secrets:{reveal:async()=>Buffer.from(bot).toString('hex')},egress:{decide:async()=>({allowed:true,host:'127.0.0.1',address:'127.0.0.1',family:4,port:Number(new URL(relay.url).port)})}});
 const until=async(fn:()=>boolean)=>{const end=Date.now()+5000;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,2));assert.ok(fn());};
 try {
  await ch.start({receive:async()=>{await ch.send({chatId:other,text:'reply'});completed=true;},fail(){},log:{info(){},warn(){},error(){}}});
  await until(()=>relay.requests.length>=3);
  relay.emit(['EVENT','buzz-inbox',wrapEvent({kind:14,content:'hello',created_at:Math.floor(Date.now()/1000),tags:[['p',pub]]},peer,pub)]);
  relay.emit(['EVENT','buzz-relays',finalizeEvent({kind:10050,content:'',created_at:Math.floor(Date.now()/1000),tags:[['relay',relay.url]]},peer)]);
  await until(()=>completed); assert.equal((relay.headers[0] as any).authorization,undefined);
 }finally{await ch.stop();await relay.close();}
});
