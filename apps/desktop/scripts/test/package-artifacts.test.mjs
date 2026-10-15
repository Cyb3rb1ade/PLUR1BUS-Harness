import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preserveArtifacts} from '../build-bundle.mjs';

test('direct online artifacts remain unchanged when offline overwrites native output', async()=>{
 const root=await mkdtemp(join(tmpdir(),'p1t-package-artifacts-'));
 const artifactRoot=join(root,'artifacts'),native=join(root,'native'),payload=join(root,'payload');
 await mkdir(artifactRoot);await mkdir(join(native,'bundle/nsis'),{recursive:true});await mkdir(join(payload,'resources'),{recursive:true});
 await writeFile(join(payload,'bundle.json'),'{}');await writeFile(join(payload,'resources/payload.json'),'{"fixture":true}');
 const installer=join(native,'bundle/nsis/PLUR1BUS.exe');await writeFile(installer,'online');
 const options={prepared:{root:payload,manifestPath:join(payload,'bundle.json'),provenance:{fixture:true}},target:'x86_64-pc-windows-msvc',channel:'beta',distribution:'direct',native,artifactRoot};
 const online=await preserveArtifacts({...options,variant:'online'});
 await writeFile(installer,'offline');
 const offline=await preserveArtifacts({...options,variant:'offline'});
 assert.equal(await readFile(join(online,'nsis/PLUR1BUS.exe'),'utf8'),'online');
 assert.equal(await readFile(join(offline,'nsis/PLUR1BUS.exe'),'utf8'),'offline');
 const report=JSON.parse(await readFile(join(online,'artifacts.json'),'utf8'));
 assert.equal(report.variant,'online');assert.equal(report.fixture,true);assert.equal(report.unsigned,true);assert.equal(report.nativeInstallValidated,false);
 assert.match(report.files[0].sha256,/^[a-f0-9]{64}$/);
 await assert.rejects(preserveArtifacts({...options,variant:'online'}),{code:'EEXIST'});
});

test('Flatpak artifact preserves ABI acceptance boundary and exact output', async()=>{
 const root=await mkdtemp(join(tmpdir(),'p1t-format-artifacts-'));
 await mkdir(join(root,'resources'));await mkdir(join(root,'artifacts'));
 await writeFile(join(root,'bundle.json'),'{}');await writeFile(join(root,'resources/payload.json'),'{}');await writeFile(join(root,'test.flatpak'),'flatpak fixture');
 const destination=await preserveArtifacts({prepared:{root,manifestPath:join(root,'bundle.json'),provenance:{fixture:true},formatPlan:{artifactPath:join(root,'test.flatpak')}},target:'aarch64-unknown-linux-gnu',channel:'stable',variant:'online',distribution:'flatpak',artifactRoot:join(root,'artifacts')});
 const report=JSON.parse(await readFile(join(destination,'artifacts.json'),'utf8'));
 assert.equal(report.runtimeAbiValidated,false);assert.equal(report.runtime,'org.gnome.Platform/49');assert.equal(report.files.length,1);
 assert.equal(await readFile(join(destination,'test.flatpak'),'utf8'),'flatpak fixture');
});
