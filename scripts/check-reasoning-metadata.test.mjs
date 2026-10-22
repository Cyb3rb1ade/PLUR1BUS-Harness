import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import * as checker from "./check-reasoning-metadata.mjs";
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

test("default coverage uses concrete IDs and aliases from the shipped D112 metadata",()=>{
 const result=checkReasoningMetadata(source());
 assert.ok(result.checked>0, "coverage must inspect shipped known models");
 assert.ok(result.missing.includes("example-vendor/example-chat-large"));
 assert.ok(result.missing.includes("example-vendor/example-chat-latest"));
});
test("D112 extraction retains vendor and escaped literals, deduplicates aliases, and ignores regex families and non-chat models",()=>{
 assert.equal(typeof checker.knownModelsFromMetadata,"function");
 const metadata={schema:"plur1bus.model-metadata/1",revision:"test",vendors:{
  alpha:[
   {pattern:"^model\\.1$",kind:"chat",capabilities:[],aliases:["model-latest"]},
   {pattern:"^model-latest$",kind:"chat",capabilities:[]},
   {pattern:"^family-[0-9]+$",kind:"chat",capabilities:[]},
   {pattern:"^embed$",kind:"embedding",capabilities:[]},
  ],
  beta:[{pattern:"^model-other$",kind:"chat",capabilities:[],aliases:["other-latest"]}],
 }};
 assert.deepEqual(checker.knownModelsFromMetadata(metadata),[
  {vendor:"alpha",id:"model-latest"},{vendor:"alpha",id:"model.1"},
  {vendor:"beta",id:"model-other"},{vendor:"beta",id:"other-latest"},
 ]);
});
test("CLI emits coverage hints from D112 without a caller-supplied model list",()=>{
 const run=spawnSync(process.execPath,["--experimental-strip-types","scripts/check-reasoning-metadata.mjs"],{
  cwd:new URL("..",import.meta.url),encoding:"utf8",
 });
 assert.equal(run.status,0,run.stderr);
 assert.match(run.stdout,/no entry for known model example-vendor\/example-chat-large/);
 assert.match(run.stdout,/2 known models checked/);
});

test("explicit empty coverage remains available for schema-only validation",()=>{
 assert.deepEqual(checkReasoningMetadata(source(),[]).missing,[]);
 assert.equal(checkReasoningMetadata(source(),[]).checked,0);
});
test("malformed D112 metadata fails instead of silently emptying coverage",()=>{
 assert.throws(()=>checker.knownModelsFromMetadata({}),/invalid model metadata/);
});
