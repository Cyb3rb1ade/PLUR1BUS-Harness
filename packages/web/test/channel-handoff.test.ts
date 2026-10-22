import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { withChat } from './chat-fixtures.ts';
import { setup, teardown, browserSkip } from './harness.ts';
import { expectAxeClean } from './axe.ts';
import { rpcError } from './mock-rpc.ts';
before(setup);after(teardown);
for(const locale of ['en','de'] as const)test(`own channel transcript is read-only and continues in a new chat (${locale})`,{skip:browserSkip},async()=>{
 const token='a'.repeat(43),source={id:'source',agentId:'bernd',title:'My DM',channel:'telegram',updatedAt:0,readOnly:true};
 await withChat({locale:locale==='de'?'de-DE':'en-US',route:'#/chat/channel/source',seed:c=>{
  c.seed({id:'existing'});c.server.rpc.handle('channel.history.list',()=>({sessions:[source],truncated:false}),{write:false});c.server.rpc.handle('channel.history.get',()=>({session:source,messages:[{role:'user',text:'<script>untrusted text</script>',createdAt:0}]}),{write:false});
  c.server.rpc.handle('channel.handoff.create',()=>({path:'#/chat/handoff/'+token,expiresAt:Date.now()+600000}));c.server.rpc.handle('channel.handoff.redeem',()=>{c.seed({id:'continued',messages:[['user','Quoted summary from the channel.']]});return {sessionId:'continued',handoffFrom:{sessionId:'source',channel:'telegram'}};});
 }},async({page,chat})=>{
  await page.getByText('<script>untrusted text</script>',{exact:true}).waitFor();assert.equal(await page.locator('textarea').count(),0);await expectAxeClean(page,'read-only channel transcript');
  await page.getByRole('button',{name:locale==='de'?'In Web fortsetzen':'Continue in Web',exact:true}).click();await page.getByText('Quoted summary from the channel.',{exact:true}).waitFor();assert.ok(!page.url().includes(token));assert.equal(chat.server.rpc.calls.filter(c=>c.method==='channel.handoff.redeem').length,1);
 });
});
test('a failed handoff does not prevent a later valid token from being redeemed', {skip:browserSkip},async()=>{
 const bad='b'.repeat(43),good='c'.repeat(43);
 await withChat({route:'#/chat/handoff/'+bad,seed:c=>{c.server.rpc.handle('channel.handoff.redeem',p=>{if((p as any).token===bad)throw rpcError('E_NOT_FOUND','unavailable');c.seed({id:'second',messages:[['user','Second link succeeded.']]});return {sessionId:'second',handoffFrom:{sessionId:'source',channel:'matrix'}};});}},async({page})=>{
  await page.getByRole('alert').getByText(/expired/).waitFor();await page.evaluate(token=>{location.hash='#/chat/handoff/'+token;},good);await page.getByText('Second link succeeded.',{exact:true}).waitFor();assert.ok(!page.url().includes(good));
 });
});
