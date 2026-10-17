import {test} from "node:test";
import assert from "node:assert/strict";
import {defaults,validate,CONFIG_SCHEMA} from "../src/index.ts";
test("security defaults preserve current behavior and annotate every new key",()=>{
 const cfg=defaults();
 assert.deepEqual(cfg.approvals,{maxGrantDays:90,requireOsConfirmation:true});
 assert.deepEqual(cfg.breakglass,{reasonMinChars:10,reasonMaxChars:500,maxWindowMinutes:60});
 for(const group of ["approvals","breakglass"]) for(const key of Object.values(CONFIG_SCHEMA.properties[group].properties) as any[]){
  assert.deepEqual(key["x-write-roles"],["owner","admin"]);assert.equal(key["x-audit"],true);
 }
});
test("security invalid bounds fail configuration loading",()=>{
 for(const [group,key,value] of [["approvals","maxGrantDays",366],["approvals","maxGrantDays",0],["breakglass","maxWindowMinutes",1441],["breakglass","reasonMinChars",0],["breakglass","reasonMaxChars",10001]] as const){
  const cfg:any=defaults();cfg[group][key]=value;assert.equal(validate(cfg).ok,false,`${group}.${key}`);
 }
 const cfg:any=defaults();cfg.breakglass.reasonMinChars=501;assert.equal(validate(cfg).ok,false);
});
test("remote defaults require a factor remotely and keep exposure keys closed and audited",()=>{
 const cfg=defaults();assert.equal(cfg.remote?.publish,"tailnet");assert.equal(cfg.remote?.tls,"self-signed");assert.equal(cfg.auth?.requireSecondFactor,"remote");
 for(const patch of [{publish:"funnel"},{tls:"none"},{noticeAck:{by:"owner",at:1,version:2}},{arbitrary:true}]){const candidate:any=defaults();candidate.remote={...candidate.remote,...patch};assert.equal(validate(candidate).ok,false);}
 const factor=CONFIG_SCHEMA.properties.auth.properties.requireSecondFactor;assert.deepEqual(factor["x-write-roles"],["owner","admin"]);assert.equal(factor["x-audit"],true);
});
