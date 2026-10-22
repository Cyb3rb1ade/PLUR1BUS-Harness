import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateParams } from '@plur1bus/rpc-schema';
import { deliveryMethods } from '../../src/delivery/rpc.ts';
import { guardMethods } from '../../src/rbac/guard.ts';
test('delivery RPC is human-only, derives the person from authentication, and closes params',async()=>{
 let p:any={userId:'alice',kind:'person',role:'member'};let seen='';
 const methods=guardMethods(deliveryMethods(()=>({list:(who:any)=>{seen=who.userId;return[];},eligible:()=>[]} as any)),{resolve:()=>p,now:()=>0});const ctx=()=>({connectionId:'c',requestId:'r',signal:new AbortController().signal});
 await methods['delivery.target.list']!({},ctx());assert.equal(seen,'alice');
 assert.equal(validateParams('delivery.target.list',{person:'victim'}).ok,false);
 for(const who of [null,{userId:'bot',kind:'agent',role:'owner'}]){p=who;await assert.rejects(methods['delivery.target.list']!({},ctx()));}
});
