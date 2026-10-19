import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRig, OWNER, flush } from './switchboard-rig.ts';
import { scriptedAdapter, turnFixture } from '../composition/helpers.ts';
import { TurnRunner } from '../../src/session/turn-loop.ts';
import { Compactor, defaultCompaction } from '../../src/session/compaction.ts';
import { tempDir } from '../helpers/temp-dir.ts';
test('one agent keeps the same persona through Telegram, Discord, Matrix and Buzz host fakes', async () => {
  const ids = ['telegram','discord','matrix','buzz'];
  const persona = 'You are Bernd. Speak calmly and explain concrete tradeoffs.';
  const wire = scriptedAdapter(ids.map(() => ({text:'Bernd replies.'})));
  const composition = turnFixture(wire.adapter, {system:[persona]}, tempDir('m4-persona-'));
  let runner: TurnRunner;
  const r = makeRig({ids, switchboard:{turns:()=>({store:r.store,runner,agentId:()=>'main'})}});
  runner = new TurnRunner({store:r.store,compactor:new Compactor(r.store,defaultCompaction(8192),{beforeSwap:async()=>{}}),memory:{recall:async()=>({text:'',degraded:null}),capture:async()=>{},checkpoint:async()=>{}},provider:()=>composition.provider});
  try {
    const human = r.identity.createHuman({displayName:'Pat'},OWNER);
    for (const id of ids) {
      r.config.set(id,{enabled:true,...(id==='matrix'?{homeserverUrl:'https://hs.test',userId:'@bot:hs.test'}:{})});
      const cfg = (r.config.current().channels as unknown as Record<string, Record<string,unknown>>)[id]!;
      for(const [key,value] of Object.entries(cfg)) if(key.endsWith('Secret') && typeof value==='string') r.secrets.put(value,'test-secret');
      const started=r.identity.startPairing({humanId:human.id,channel:id},OWNER);
      const claimed=r.identity.claim({code:started.code,identity:{channel:id,accountId:'bot',userId:'sender'}});
      r.identity.confirm({pairingId:claimed.pairingId,approve:true},OWNER);
    }
    await r.switchboard.start(); await r.clock.advance(0);
    for(const id of ids) await r.adapter(id).inbound({accountId:'bot',senderId:'sender',chatId:'dm-'+id,text:'Who are you?'});
    await flush();
    assert.equal(wire.requests.length,4);
    for(const request of wire.requests) assert.ok(JSON.stringify(request.messages).includes(persona));
    assert.deepEqual(wire.requests.map(q=>q.messages.filter(m=>m.role==='system')), Array(4).fill(wire.requests[0]!.messages.filter(m=>m.role==='system')));
    for(const id of ids) assert.equal(r.adapter(id).sent.at(-1)?.text,'Bernd replies.');
  } finally {await r.switchboard.stop();r.close();composition.close();}
});
