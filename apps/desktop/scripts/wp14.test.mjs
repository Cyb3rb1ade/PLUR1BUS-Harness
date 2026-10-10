import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {appleReport} from './apple-e2e.mjs';
import {containerPlan} from './container-e2e.mjs';
test('container acceptance is explicit, local and uses prebuilt fixtures',()=>{
 for(const runtime of ['docker','podman']) {
  const plan=containerPlan(runtime);
  assert.equal(plan.runtime,runtime);
  assert.equal(plan.registry,'registry:2');
  assert.equal(plan.upgrade.at(-1),'--prebuilt');
  assert.match(plan.controller,/controller_e2e_/);
 }
 assert.throws(()=>containerPlan('container'));
});
test('Apple scaffold discloses absence and never invents real acceptance',()=>{
 assert.deepEqual(appleReport({platform:'linux',version:null}),{schema:'desktop.apple-e2e/1',status:'skipped',reason:'macOS required',version:null});
 assert.equal(appleReport({platform:'darwin',version:null}).reason,'Apple container CLI unavailable');
 assert.equal(appleReport({platform:'darwin',version:'container CLI 1.3.0'}).status,'scaffold');
});
test('container workflows pin the same actions as desktop, without secrets or privileged PR events',()=>{
 const desktop=readFileSync(new URL('../../../.github/workflows/desktop.yml',import.meta.url),'utf8');
 for(const name of ['container-shell','apple-container']) {
  const text=readFileSync(new URL(`../../../.github/workflows/${name}.yml`,import.meta.url),'utf8');
  assert.doesNotMatch(text,/pull_request_target|secrets\./);
  for(const [,action] of text.matchAll(/uses:\s*(\S+)/g)) {
   assert.match(action,/@[a-f0-9]{40}$/);
   assert.ok(desktop.includes(action),action);
  }
 }
});
test('unsigned builds disable updater artifacts; only the release overlay enables them',()=>{
 const base=JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url)));
 const release=JSON.parse(readFileSync(new URL('../src-tauri/tauri.release.conf.json',import.meta.url)));
 assert.equal(base.bundle.createUpdaterArtifacts,false);
 assert.equal(release.bundle.createUpdaterArtifacts,true);
});
