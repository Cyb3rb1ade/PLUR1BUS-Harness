import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {appleReport} from './apple-e2e.mjs';
import {containerPlan,podmanRegistryConfig} from './container-e2e.mjs';
import {loopbackAddress,manifestDigest} from './stub-digest.mjs';
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

test('owned Podman service trusts only the exact loopback registry port',()=>{
 assert.equal(podmanRegistryConfig('127.0.0.1:32768'),'[[registry]]\nlocation = "127.0.0.1:32768"\ninsecure = true\n');
 assert.throws(()=>podmanRegistryConfig('registry.example:5000'));
 assert.throws(()=>podmanRegistryConfig('0.0.0.0:5000'));
});

test('stub fixtures are pinned by registry manifest digest, never by image ID',()=>{
 const digest=`sha256:${'a'.repeat(64)}`;
 assert.equal(manifestDigest(digest),digest);
 assert.throws(()=>manifestDigest(null),/digest missing/);
 assert.throws(()=>manifestDigest('abc'),/digest missing/);
 assert.equal(loopbackAddress('127.0.0.1:32768\n[::]:32768'),'127.0.0.1:32768');
 assert.throws(()=>loopbackAddress('0.0.0.0:32768'),/loopback/);
 for(const script of ['container-e2e','upgrade-e2e'])assert.doesNotMatch(readFileSync(new URL(`./${script}.mjs`,import.meta.url),'utf8'),/\{\{\.Id\}\}/);
});
