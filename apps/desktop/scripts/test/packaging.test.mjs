import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareBundle} from '../prepare-bundle.mjs';

test('online and offline fixtures package separate resources with exact checksums',async()=>{
 const root=await mkdtemp(join(tmpdir(),'d1-package-'));
 try {
  const online=await prepareBundle({outDir:join(root,'online'),target:'aarch64-apple-darwin',variant:'online',channel:'beta',ciFixture:true});
  const offline=await prepareBundle({outDir:join(root,'offline'),target:'aarch64-apple-darwin',variant:'offline',channel:'beta',ciFixture:true});
  const manifest=JSON.parse(await readFile(offline.manifestPath,'utf8'));
  const config=JSON.parse(await readFile(offline.configPath,'utf8'));
  assert.equal(manifest.tarball.arm64,'image/plur1bus-harness-arm64.oci.tar');
  assert.equal(JSON.parse(await readFile(online.manifestPath,'utf8')).tarball.arm64,null);
  assert.equal(config.bundle.macOS.signingIdentity,'-');
  assert.ok(Object.values(config.bundle.resources).includes('apple/container.pkg'));
  assert.ok(Object.values(config.bundle.resources).includes('cli/plur1bus'));
  assert.equal(manifest.snapshotRuntime.nodeVersion,'24.21.0');
  assert.equal(manifest.snapshotRuntime.node.path,'snapshot/node');
  assert.equal(manifest.snapshotRuntime.entry.path,'snapshot/import-snapshot.mjs');
  assert.match(manifest.snapshotRuntime.node.sha256,/^[a-f0-9]{64}$/);
  assert.match(manifest.snapshotRuntime.entry.sha256,/^[a-f0-9]{64}$/);
  assert.ok(Object.values(config.bundle.resources).includes('snapshot/node'));
  assert.ok(Object.values(config.bundle.resources).includes('snapshot/import-snapshot.mjs'));
  assert.ok(Object.values(config.bundle.resources).includes('image/plur1bus-harness-arm64.oci.tar'));
  assert.equal(config.bundle.createUpdaterArtifacts,false);
  const image=await readFile(join(offline.root,'resources/image/plur1bus-harness-arm64.oci.tar'));
  assert.equal(image.length%512,0);
  assert.ok(image.includes(Buffer.from('oci-layout')));
  assert.equal(offline.provenance.fixture,true);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('unconfigured production payload and unsupported channels/targets fail closed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'d1-package-'));
 try {
  await assert.rejects(prepareBundle({outDir:join(root,'real'),target:'aarch64-apple-darwin',variant:'online',channel:'stable'}));
  for(const change of [{target:'../../foreign'},{channel:'nightly'},{variant:'remote'}])
   await assert.rejects(prepareBundle({outDir:join(root,Math.random().toString()),target:'x86_64-pc-windows-msvc',channel:'beta',variant:'online',ciFixture:true,...change}));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Store and Flatpak are online-only; Windows offline carries the Evergreen offline installer mode',async()=>{
 const root=await mkdtemp(join(tmpdir(),'d1-package-'));
 try {
  for(const distribution of ['store','flatpak'])await assert.rejects(prepareBundle({outDir:join(root,distribution),target:distribution==='store'?'x86_64-pc-windows-msvc':'x86_64-unknown-linux-gnu',variant:'offline',channel:'beta',distribution,ciFixture:true}));
  const win=await prepareBundle({outDir:join(root,'win'),target:'aarch64-pc-windows-msvc',variant:'offline',channel:'beta',ciFixture:true});
  const config=JSON.parse(await readFile(win.configPath,'utf8'));
  assert.deepEqual(config.bundle.windows.webviewInstallMode,{type:'offlineInstaller',silent:true});
 }finally{await rm(root,{recursive:true,force:true});}
});
