import {test} from "node:test";
import assert from "node:assert/strict";
import {ToolDispatcher} from "../../src/tools/dispatcher.ts";
import {ToolRegistry} from "../../src/tools/registry.ts";
import {DEFAULTS} from "../../src/policy/index.ts";
import type {Grant} from "../../src/policy/index.ts";
test("expired runAs grants cause a normal approval; its timeout refuses the tool and never mints grants",async()=>{
 const now=100*24*60*60_000;let executions=0;const asks:any[]=[];
 const registry=new ToolRegistry();registry.register({name:"demo.shell",description:"shell",capability:"shell.exec",effect:"local-write",risk:"medium",classify:()=>({flags:{outsideRoots:false,denyListHit:false,sandboxed:true}}),inputSchema:{type:"object"},execute:async()=>{executions++;return "done";}});
 const expired:Grant={id:"grant",person:"alice",agent:"main",capability:"shell.exec",scope:"always",match:{kind:"capability"},createdAt:0,surface:2};
 const dispatcher=new ToolDispatcher({registry,clock:{now:()=>now},grants:{list:()=>[expired],get:()=>expired},approvals:{request:async a=>{asks.push(a);return{approved:false,parked:true,reason:"parked"};}}});
 const result=await dispatcher.call({id:"call",name:"demo.shell",args:{}},{principal:"alice",agentId:"main",surface:0,recurring:{jobId:"user:daily",jobName:"Daily"},signal:new AbortController().signal});
 assert.ok(now>DEFAULTS.lifetimes.alwaysUnusedMs);assert.equal(executions,0);assert.equal(asks.length,1);assert.equal(asks[0].principal,"alice");assert.equal(asks[0].recurring.jobName,"Daily");assert.ok(result.isError);if(result.isError)assert.equal(result.error.sourceCode,"approval-timeout");
 expired.createdAt=now;const allowed=await dispatcher.call({id:"second",name:"demo.shell",args:{}},{principal:"alice",agentId:"main",surface:0,recurring:{jobId:"user:daily",jobName:"Daily"},signal:new AbortController().signal});assert.equal(allowed.isError,false);assert.equal(executions,1);assert.equal(asks.length,1);
});
