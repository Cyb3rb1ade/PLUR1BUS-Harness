// Stage signed-app inputs without downloading executables or touching an installed application.
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile,lstat,mkdir,mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {writeTarGz} from '../../../scripts/release/archive.mjs';
import {stageSnapshotRuntime} from './snapshot-runtime.mjs';

const desktop=fileURLToPath(new URL('..',import.meta.url));
const targets=new Map([
 ['aarch64-apple-darwin',{arch:'arm64',os:'macos',cli:'plur1bus',bundles:['app','dmg']}],
 ['x86_64-pc-windows-msvc',{arch:'amd64',os:'windows',cli:'plur1bus.exe',bundles:['nsis']}],
 ['aarch64-pc-windows-msvc',{arch:'arm64',os:'windows',cli:'plur1bus.exe',bundles:['nsis']}],
 ['x86_64-unknown-linux-gnu',{arch:'amd64',os:'linux',cli:'plur1bus',bundles:['deb','rpm','appimage']}],
 ['aarch64-unknown-linux-gnu',{arch:'arm64',os:'linux',cli:'plur1bus',bundles:['deb','rpm','appimage']}],
]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function regular(path){const m=await lstat(path);if(!m.isFile()||m.isSymbolicLink())throw Error('payload-not-regular');return m;}
async function copy(source,destination){await regular(source);await mkdir(dirname(destination),{recursive:true});await copyFile(source,destination);}
async function files(root,prefix=''){
 const result=[];
 for(const name of (await readdir(join(root,prefix))).sort()){
  const rel=prefix?`${prefix}/${name}`:name;
  if(!/^[A-Za-z0-9_./ -]+$/.test(rel)||name==='.'||name==='..')throw Error('payload-name-invalid');
  const meta=await lstat(join(root,rel));if(meta.isSymbolicLink())throw Error('payload-symlink');
  if(meta.isDirectory())result.push(...await files(root,rel));else if(meta.isFile())result.push(rel);else throw Error('payload-not-regular');
 }
 return result;
}
async function fixtureImage(root,arch){
 const layerGz=join(root,'fixture-layer.tar.gz');
 await writeTarGz([{name:'CI-PLACEHOLDER-NOT-RUNNABLE',data:'Packaging fixture only. No harness or models.\n'}],layerGz);
 const layer=gunzipSync(await readFile(layerGz));
 const config=Buffer.from(JSON.stringify({architecture:arch,os:'linux',config:{Labels:{'app.plur1bus.ci-placeholder':'true'},Entrypoint:['/CI-PLACEHOLDER-NOT-RUNNABLE']},rootfs:{type:'layers',diff_ids:[`sha256:${sha(layer)}`]}}));
 const descriptor=(data,mediaType)=>({mediaType,digest:`sha256:${sha(data)}`,size:data.length});
 const manifest=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:descriptor(config,'application/vnd.oci.image.config.v1+json'),layers:[descriptor(layer,'application/vnd.oci.image.layer.v1.tar')]}));
 const index=JSON.stringify({schemaVersion:2,manifests:[{...descriptor(manifest,'application/vnd.oci.image.manifest.v1+json'),platform:{architecture:arch,os:'linux'}}]});
 const tarGz=join(root,'fixture-image.tar.gz');
 await writeTarGz([{name:'oci-layout',data:'{"imageLayoutVersion":"1.0.0"}'},{name:'index.json',data:index},...[[layer,sha(layer)],[config,sha(config)],[manifest,sha(manifest)]].map(([data,hash])=>({name:`blobs/sha256/${hash}`,data}))],tarGz);
 return {bytes:gunzipSync(await readFile(tarGz)),digest:`sha256:${sha(manifest)}`};
}
/** Prepare an explicit online/offline target. CI fixtures are inert and are labelled in the payload. */
export async function prepareBundle(options){
 const {target,variant,channel,ciFixture=false,distribution='direct'}=options;
 const platform=targets.get(target);
 if(!platform||!['online','offline'].includes(variant)||!['dev','beta','stable'].includes(channel)||!['direct','store','flatpak'].includes(distribution))throw Error('unsupported-bundle-selection');
 if(distribution!=='direct'&&variant!=='online')throw Error('distribution-online-only');
 if(distribution==='store'&&platform.os!=='windows'||distribution==='flatpak'&&platform.os!=='linux')throw Error('distribution-target-mismatch');
 const root=resolve(options.outDir);
 await mkdir(root,{recursive:false});
 const resources=join(root,'resources');await mkdir(resources);
 const manifest=JSON.parse(await readFile(options.bundleInput??join(desktop,'bundle/bundle.json.tmpl'),'utf8'));
 if(!ciFixture&&(!options.cliPath||platform.os==='macos'&&!options.applePkgPath||variant==='offline'&&(!options.imagePath||!options.modelsDir)))throw Error('release-payload-inputs-required');
 const cliPath=join(resources,'cli',platform.cli);
 if(ciFixture){await mkdir(dirname(cliPath),{recursive:true});await writeFile(cliPath,platform.os==='windows'?'CI PLACEHOLDER - not a PE executable\n':'#!/bin/sh\nprintf "%s\\n" "CI PLACEHOLDER - no host CLI" >&2\nexit 2\n',{mode:0o755});}
 else await copy(options.cliPath,cliPath);
 manifest.cli={path:`cli/${platform.cli}`,sha256:await fileHash(cliPath)};
 manifest.snapshotRuntime=await stageSnapshotRuntime({target,resources,archive:options.snapshotNodeArchive,fixture:ciFixture});
 if(platform.os==='macos'){
  const pkg=join(resources,'apple/container.pkg');
  if(ciFixture){await mkdir(dirname(pkg),{recursive:true});await writeFile(pkg,'CI PLACEHOLDER - not an Apple installer\n');}
  else await copy(options.applePkgPath,pkg);
  const hash=await fileHash(pkg);
  if(!ciFixture&&manifest.apple.pkgSha256!==hash)throw Error('apple-package-checksum-mismatch');
  manifest.apple={...manifest.apple,pkgPath:'apple/container.pkg',pkgSha256:hash};
 }
 manifest.tarball={amd64:null,arm64:null};
 if(variant==='offline'){
  const rel=`image/plur1bus-harness-${platform.arch}.oci.tar`;
  const image=join(resources,rel);await mkdir(dirname(image),{recursive:true});
  if(ciFixture){const fixture=await fixtureImage(root,platform.arch);await writeFile(image,fixture.bytes);manifest.images[platform.arch]=fixture.digest;}
  else await copy(options.imagePath,image);
  manifest.tarball[platform.arch]=rel;
  if(ciFixture){await mkdir(join(resources,'models'));await writeFile(join(resources,'models/CI-PLACEHOLDER.txt'),'No model weights in this packaging fixture. Offline inference is not tested.\n');}
  else {for(const file of await files(options.modelsDir))await copy(join(options.modelsDir,file),join(resources,'models',file));}
 }
 const resourceMap={};const payload=[];
 for(const path of await files(resources)){
  resourceMap[join(resources,path)]=path;
  const file=join(resources,path);payload.push({path,size:(await regular(file)).size,sha256:await fileHash(file)});
 }
 const provenance={schema:'desktop.bundle-payload/1',target,variant,channel,distribution,fixture:ciFixture,signing:options.signingIdentity?'configured':'unsigned-or-ad-hoc',files:payload};
 await writeFile(join(resources,'payload.json'),JSON.stringify(provenance,null,2)+'\n');
 resourceMap[join(resources,'payload.json')]='payload.json';
 const config={bundle:{resources:resourceMap,createUpdaterArtifacts:false}};
 if(platform.os==='macos')config.bundle.macOS={signingIdentity:options.signingIdentity||'-'};
 if(platform.os==='windows')config.bundle.windows={signCommand:null,webviewInstallMode:distribution==='store'?{type:'skip'}:{type:variant==='offline'?'offlineInstaller':'downloadBootstrapper',silent:true}};
 const manifestPath=join(root,'bundle.json'),configPath=join(root,'tauri.variant.conf.json');
 await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
 return {root,manifestPath,configPath,provenance,bundles:platform.bundles};
}
async function cli(){
 const args=process.argv.slice(2),flags=new Map();
 while(args.length){const key=args.shift();if(key==='--ci-fixture')flags.set(key,true);else {if(!key?.startsWith('--')||!args.length)throw Error('invalid-packaging-arguments');flags.set(key,args.shift());}}
 const base=join(desktop,'../../.superpowers/d1');await mkdir(base,{recursive:true});
 const reserved=await mkdtemp(join(base,'payload-'));
 const result=await prepareBundle({outDir:join(reserved,'stage'),target:flags.get('--target'),variant:flags.get('--variant'),channel:flags.get('--channel')??'beta',distribution:flags.get('--distribution')??'direct',ciFixture:flags.get('--ci-fixture')===true,bundleInput:process.env.PLUR1BUS_DESKTOP_RELEASE_MANIFEST,cliPath:process.env.PLUR1BUS_DESKTOP_HOST_CLI,snapshotNodeArchive:flags.get('--snapshot-node-archive')??process.env.PLUR1BUS_DESKTOP_SNAPSHOT_NODE_ARCHIVE,applePkgPath:process.env.PLUR1BUS_DESKTOP_APPLE_PKG,imagePath:process.env.PLUR1BUS_DESKTOP_OFFLINE_IMAGE,modelsDir:process.env.PLUR1BUS_DESKTOP_OFFLINE_MODELS,signingIdentity:process.env.APPLE_SIGNING_IDENTITY});
 console.log(JSON.stringify({manifestPath:result.manifestPath,configPath:result.configPath,bundles:result.bundles,fixture:result.provenance.fixture}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))cli().catch(()=>{console.error('DESKTOP_PAYLOAD_PREPARATION_FAILED');process.exitCode=1;});
