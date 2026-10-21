import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {checkReasoningMetadata} from "./check-reasoning-metadata.mjs";
const source=()=>JSON.parse(readFileSync(new URL("../packages/core/catalog/reasoning-metadata.json",import.meta.url),"utf8"));
test("unknown known-model IDs are coverage hints, not validation failures",()=>{
 assert.deepEqual(checkReasoningMetadata(source(),[{vendor:"new",id:"unknown-model"}]).missing,["new/unknown-model"]);
});
test("schema rejects unknown keys and bad parameter types; compiler rejects unsafe and duplicate patterns",()=>{
 for(const mutate of [d=>{d.typo=true;},d=>{d.vendors.anthropic[0].levels=3;},d=>{d.vendors.anthropic[0].pattern="^(a+)+$";},d=>{d.vendors.anthropic.push(d.vendors.anthropic[0]);}]){
  const data=source();mutate(data);assert.throws(()=>checkReasoningMetadata(data));
 }
});
