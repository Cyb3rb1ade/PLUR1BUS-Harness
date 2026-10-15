import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from '../src/nostr.ts';
import { npubEncode } from '../src/nostr.ts';
import { wrapEvent, unwrapEvent, createRumor, createSeal, createWrap } from '../src/nostr.ts';
import { BuzzChannel, MemorySeenStore, publicKey, relayUrl, FileSeenStore } from '../src/index.ts';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const tick = async () => { for(let i=0;i<10;i++) await new Promise(r => setImmediate(r)); };
const relay = 'wss://relay.example/';
async function rig(denied = false, seen = new MemorySeenStore()) {
  const bot = generateSecretKey(), peer = generateSecretKey(), botPub = getPublicKey(bot), peerPub = getPublicKey(peer);
  const received: any[] = [], sent: any[] = [], logs: any[] = [], connections: any[] = [];
  const channel = new BuzzChannel({ relays: [relay], senderAllowlist: [npubEncode(peerPub)] }, {
    secrets: { reveal: async () => Buffer.from(bot).toString('hex') }, seen,
    egress: { decide: async () => denied ? { allowed: false, reason: 'host', message: '' } as never : { allowed: true, host: 'relay.example', port:443, address:'192.0.2.1', family:4 } },
    logger: { log: (...args) => { logs.push(args); } },
    connect: async r => { connections.push(r); return { send: async v => { sent.push(v); const a = v as any; if (a[0] === "EVENT") await r.onMessage(["OK",a[1].id,true,""]); }, close: async () => r.onClose() }; }
  });
  await channel.start({ receive: async m => { received.push(m); }, fail: () => {}, log: {info(){},warn(){},error(){}} }); await tick();
  const event = (key=peer, text='hello') => wire(wrapEvent({kind:14,content:text,created_at:Math.floor(Date.now()/1000),tags:[['p',botPub]]},key,botPub));
  const deliver = async (e: unknown, sub='buzz-inbox') => { await connections[0].onMessage(['EVENT',sub,e]); await channel.idle(); };
  const metadata = async () => deliver(wire(finalizeEvent({kind:10050,content:'',created_at:Math.floor(Date.now()/1000),tags:[['relay',relay]]},peer)),'buzz-relays');
  return {channel,bot,peer,botPub,peerPub,received,sent,logs,connections,event,deliver,metadata};
}
test('normalizes keys and refuses insecure or credential-bearing relays', () => {
 const key = getPublicKey(generateSecretKey()); assert.equal(publicKey(npubEncode(key)),key); assert.equal(publicKey(key.toUpperCase()),key);
 for(const url of ['ws://example.com','wss://u:p@example.com','wss://example.com/?secret=x','https://example.com']) assert.throws(()=>relayUrl(url));
 assert.equal(relayUrl('ws://127.0.0.1:3000'), 'ws://127.0.0.1:3000/');
});
test('real signed and encrypted DM enters host once; outgoing uses recipient DM relay metadata', async () => {
 const r=await rig(); try {
  const e=r.event(); await r.deliver(e); await r.deliver(e); assert.equal(r.received.length,1); assert.equal(r.received[0].senderId,r.peerPub);
  await assert.rejects(r.channel.send({chatId:r.peerPub,text:'reply'}),/DM relay/);
  await r.metadata(); await r.channel.send({chatId:r.peerPub,text:'reply'});
  const out=r.sent.filter(v=>v[0]==='EVENT'&&v[1].kind===1059&&v[1].tags.some((t:string[])=>t[1]===r.peerPub));
  assert.equal(unwrapEvent(out[0][1],r.peer).content,'reply'); assert.ok((await r.channel.health()).ok);
 } finally {await r.channel.stop();} assert.equal((await r.channel.health()).ok,false);
});
test('bad signatures, unknown senders, oversized events and wrong subscription do not reach host', async()=>{
 const r=await rig();try {
  const bad=r.event(); bad.sig='0'.repeat(128); await r.deliver(bad);
  await r.deliver(r.event(generateSecretKey())); await r.deliver({...r.event(), content:'x'.repeat(140000)});
  await r.deliver(r.event(),'foreign'); assert.equal(r.received.length,0);
 }finally{await r.channel.stop();}
});
test('re-wrapping the same rumor is deduped and persisted before delivery',async()=>{
 const r=await rig();try{ const rumor=createRumor({kind:14,content:'same',created_at:Math.floor(Date.now()/1000),tags:[['p',r.botPub]]},r.peer); const make=()=>wire(createWrap(createSeal(rumor,r.peer,r.botPub),r.botPub)); await r.deliver(make()); await r.deliver(make());assert.equal(r.received.length,1); }finally{await r.channel.stop();}
});
test('denied egress never reaches connect and shutdown cancels backoff',async()=>{
 const r=await rig(true);try{assert.equal(r.connections.length,0);assert.equal((await r.channel.health()).ok,false);}finally{await r.channel.stop();}
});
test('relay closure reports unhealthy and errors never log key contents',async()=>{
 const r=await rig();try{r.connections[0].onClose();assert.equal((await r.channel.health()).ok,false);assert.ok(!JSON.stringify(r.logs).includes(Buffer.from(r.bot).toString('hex')));}finally{await r.channel.stop();}
});
test('file claims persist privately across store instances',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'buzz-'));try{const s=new FileSeenStore(dir);await s.save(['a'.repeat(64)]);assert.deepEqual(await new FileSeenStore(dir).load(),['a'.repeat(64)]);if(process.platform!=='win32')assert.equal((await stat(s.file)).mode&0o777,0o600);}finally{await rm(dir,{recursive:true,force:true});}
});

test('channel contract: manifest, missing secret and group exclusion',async()=>{
 const manifest = (await import('../channel.json',{with:{type:'json'}})).default;
 assert.equal(manifest.name,'buzz');assert.deepEqual(manifest.chatKinds,['direct']);
 const c=new BuzzChannel({relays:[relay],senderAllowlist:[]},{secrets:{reveal:async()=>null},seen:new MemorySeenStore(),egress:{decide:async()=>{throw new Error();}}});
 await assert.rejects(c.start({receive:async()=>{},fail(){},log:{info(){},warn(){},error(){}}}),/unavailable/);await c.stop();
 const r=await rig();try{await r.deliver(wire(wrapEvent({kind:14,content:'group',created_at:Math.floor(Date.now()/1000),tags:[['p',r.botPub],['p',getPublicKey(generateSecretKey())]]},r.peer,r.botPub)));assert.equal(r.received.length,0);}finally{await r.channel.stop();}
});
