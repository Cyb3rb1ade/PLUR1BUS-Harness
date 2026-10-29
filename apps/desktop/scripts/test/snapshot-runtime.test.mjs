// Snapshot packaging authenticates native bytes and runs the actual bundled shared producer on disposable data.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {stageSnapshotRuntime} from '../snapshot-runtime.mjs';
import {writeDesktopSourceConfig} from '../../../../packages/core/test/import/desktop-source-fixture.ts';

test('a tampered Node distribution cannot become an executable snapshot resource',async()=>{
 const root=await mkdtemp(join(tmpdir(),'d-snapshot-pin-'));
 try{
  const archive=join(root,'node-v24.21.0-linux-x64.tar.gz');
  await writeFile(archive,'untrusted bytes');
  const resources=join(root,'resources');
  await assert.rejects(stageSnapshotRuntime({target:'x86_64-unknown-linux-gnu',resources,archive}),/snapshot-node-archive-checksum/);
  await assert.rejects(access(join(resources,'snapshot/node')));
  await assert.rejects(access(join(resources,'snapshot/import-snapshot.mjs')));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the bundled producer creates a private snapshot without shipping source credentials or the Engine',async()=>{
 const root=await mkdtemp(join(tmpdir(),'d-snapshot-bundle-'));
 try{
  const resources=join(root,'resources');
  const metadata=await stageSnapshotRuntime({target:'x86_64-unknown-linux-gnu',resources,fixture:true});
  const entry=join(resources,metadata.entry.path);
  const contents=await readFile(entry);
  assert.equal(createHash('sha256').update(contents).digest('hex'),metadata.entry.sha256);
  assert.equal(contents.includes(Buffer.from('@cyb3rb1ade/plur1bus-memory')),false);
  const source=join(root,'source'),home=join(root,'home');
  await mkdir(source);await mkdir(home);
  const sourceType=writeDesktopSourceConfig(source);
  await writeFile(join(source,'SOUL.md'),'Snapshot persona\n');
  await writeFile(join(source,'.env'),'TOKEN=PRIVATE_SNAPSHOT_MARKER\n');
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',entry],{
   input:JSON.stringify({schema:'desktop.import-snapshot/1',sourceType,sourceRoot:source,home,
    stagingDir:join(home,'snapshot'),allowLiveCopy:false}),encoding:'utf8',timeout:30_000,
   env:{PATH:process.env.PATH??''},
  });
  assert.equal(child.status,0,child.stderr);
  const result=JSON.parse(child.stdout);
  assert.equal(result.ok,true);
  assert.ok(result.fileCount>=2);
  assert.equal(child.stdout.includes(root),false);
  assert.equal(child.stdout.includes('PRIVATE_SNAPSHOT_MARKER'),false);
  const archive=await readFile(join(home,'snapshot.tar.gz'));
  assert.equal(createHash('sha256').update(archive).digest('hex'),result.sha256);
  const tar=gunzipSync(archive);
  assert.equal(tar.includes(Buffer.from('Snapshot persona')),true);
  assert.equal(tar.includes(Buffer.from('PRIVATE_SNAPSHOT_MARKER')),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
