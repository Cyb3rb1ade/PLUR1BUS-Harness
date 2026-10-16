import test from "node:test";
import assert from "node:assert/strict";
import { buildChatHandlers, CHAT_ROUTES } from "../src/chat-routes.ts";
import type { HandlerInput } from "../src/routes.ts";
const input=(over:Partial<HandlerInput>={}):HandlerInput=>({body:{text:"never start"},principal:{kind:"user",id:"alice",role:"member"},pathParams:{sessionId:"ses_owned"},headers:{accept:"text/event-stream"},...over} as HandlerInput);
const audit={emit:()=>{}};
test("malformed resume/header/body facts are refused before any Core call",async()=>{
 let calls=0;const handlers=buildChatHandlers({call:async<T>()=>{calls++;return{} as T;}},audit);
 for(const bad of [input({headers:{accept:"text/event-stream","last-event-id":"ses_owned:1"}}),input({headers:{accept:"text/event-stream","last-event-id":"foreign:1","idempotency-key":"original"}}),input({headers:{accept:"text/event-stream","last-event-id":"ses_owned:01","idempotency-key":"original"}}),input({headers:{accept:"text/event-stream","last-event-id":["ses_owned:1","ses_owned:2"],"idempotency-key":"original"}}),input({headers:{accept:"application/json","last-event-id":"ses_owned:1","idempotency-key":"original"}}),input({body:{text:"no",sessionId:"other"}}),input({body:{text:"no",idempotencyKey:"body"}})])await assert.rejects(async()=>handlers["chats.submit"]!(bad),(e:unknown)=>(e as any).status===400);
 assert.equal(calls,0);
});
test("HTTP chat result contracts are self-contained and invalid backend output is not emitted",async()=>{
 for(const route of CHAT_ROUTES){const schema=JSON.stringify(route.success.schema);assert.ok(!schema.includes('"$ref"'));assert.notEqual(schema,'{"type":"object"}');}
 const handlers=buildChatHandlers({call:async<T>()=>({sessions:[],truncated:false,unexpected:"must not leak"} as T)},audit);
 await assert.rejects(async()=>handlers["chats.list"]!(input({body:undefined,pathParams:{},headers:{}})),(e:unknown)=>(e as any).status===502&&(e as any).reason==="chat-result");
});
