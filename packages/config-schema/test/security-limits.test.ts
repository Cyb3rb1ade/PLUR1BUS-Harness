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
