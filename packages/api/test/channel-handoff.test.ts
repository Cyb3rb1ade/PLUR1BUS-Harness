import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_HANDOFF_ROUTES, channelHandoffHandlers } from '../src/channel-handoff-routes.ts';
import { ROUTES } from '../src/routes.ts';
test('channel handoff REST routes require login, mutation CSRF and closed params',async()=>{
 for(const route of CHANNEL_HANDOFF_ROUTES){assert.equal(route.auth,'session');assert.equal(route.csrf,route.method==='POST');assert.ok(ROUTES.some(r=>r.id===route.id));assert.ok(!JSON.stringify(route.success.schema).includes('"$ref"'));}
 let calls=0;const handlers=channelHandoffHandlers({call:async<T>()=>{calls++;return {sessions:[],truncated:false} as T;}});
 await handlers['channel.history.list']!({pathParams:{}} as any);assert.equal(calls,1);
 await assert.rejects(async()=>handlers['channel.history.list']!({pathParams:{},query:new URLSearchParams('person=victim')} as any));
 await assert.rejects(async()=>handlers['channel.handoff.redeem']!({body:{token:'x'.repeat(43),person:'victim'}} as any));assert.equal(calls,1);
});
