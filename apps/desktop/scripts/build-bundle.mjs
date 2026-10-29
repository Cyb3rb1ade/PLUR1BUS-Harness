// Explicit native packaging entry point. Staging never installs or signs with repo credentials.
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,copyFile,readdir,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareBundle} from './prepare-bundle.mjs';
import {stagePackageFormat} from './package-formats.mjs';
const desktop=fileURLToPath(new URL('..',import.meta.url));
function run(command,args,env=process.env){return new Promise((ok,fail)=>{const child=spawn(command,args,{cwd:desktop,env,stdio:'inherit'});child.once('error',fail);child.once('exit',code=>code===0?ok():fail(Error('native-packaging-command-failed')));});}
export async function buildBundle(options){
 const root=join(desktop,'../../.superpowers/d1');await mkdir(root,{recursive:true});
 const stage=await mkdtemp(join(root,'bundle-'));
 const prepared=await prepareBundle({...options,outDir:join(stage,'payload')});
 const suffix=options.target.includes('windows')?'.exe':'';
 const targetRoot=resolve(desktop,process.env.CARGO_TARGET_DIR??'target');
 // The sidecar is a real host helper even when the optional user CLI is an inert fixture.
 await run('cargo',['build','--locked','--release','--target',options.target,'-p','plur1bus-host']);
 await mkdir(join(desktop,'src-tauri/binaries'),{recursive:true});
 await copyFile(join(targetRoot,options.target,'release',`plur1bus-host${suffix}`),join(desktop,'src-tauri/binaries',`plur1bus-host-${options.target}${suffix}`));
 const args=[join(desktop,'node_modules/@tauri-apps/cli/tauri.js'),'build','--target',options.target,'--config',prepared.configPath];
 if(options.channel==='dev')args.push('--debug');
 if(options.distribution==='store'||options.distribution==='flatpak')args.push('--config',join(desktop,'src-tauri/tauri.store.conf.json'),'--features','store','--no-bundle');

 else args.push('--bundles',prepared.bundles.join(','));
 args.push('--','--locked');
 if(options.distribution==='store'||options.distribution==='flatpak')args.push('--no-default-features');
 await run(process.execPath,args,{...process.env,PLUR1BUS_DESKTOP_BUNDLE_MANIFEST:prepared.manifestPath,PLUR1BUS_DESKTOP_BUILD_CHANNEL:options.channel,...(options.ciFixture?{PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY:'1'}:{})});
 if(options.distribution==='store'||options.distribution==='flatpak'){
  const native=join(targetRoot,options.target,options.channel==='dev'?'debug':'release');
  const plan=await stagePackageFormat({format:options.distribution==='store'?'msix':'flatpak',target:options.target,variant:options.variant,outDir:join(stage,'format'),binaryPath:join(native,`plur1bus-desktop${suffix}`),helperPath:join(native,`plur1bus-host${suffix}`),resourcesDir:join(prepared.root,'resources'),iconsDir:join(desktop,'src-tauri',options.distribution==='store'?'packaging-assets/msix':'icons'),hicolorDir:options.distribution==='flatpak'?join(desktop,'src-tauri/packaging-assets/hicolor'):undefined,version:'0.1.0',storeBuild:true,publisher:process.env.PLUR1BUS_MSIX_PUBLISHER,identityName:process.env.PLUR1BUS_MSIX_IDENTITY,execute:options.executeFormats===true});
  prepared.formatPlan=plan;
 }
 if(options.artifactRoot)prepared.artifacts=await preserveArtifacts({prepared,target:options.target,channel:options.channel,variant:options.variant,distribution:options.distribution??'direct',native:join(targetRoot,options.target,options.channel==='dev'?'debug':'release'),artifactRoot:options.artifactRoot});
 return prepared;
}
// Copy each variant immediately: Tauri reuses the same bundle output names on the next build.
export async function preserveArtifacts({prepared,target,channel,variant,distribution,native,artifactRoot}) {
 const destination=join(resolve(artifactRoot),`${distribution}-${variant}`);
 await mkdir(destination,{recursive:false});
 const files=[];
 const save=async(source,name)=>{
  if(!(await lstat(source)).isFile())throw Error('artifact-not-regular-file');
  const output=join(destination,name);await mkdir(resolve(output,'..'),{recursive:true});await copyFile(source,output);
  const hash=createHash('sha256');for await(const bytes of createReadStream(output))hash.update(bytes);
  files.push({path:name,size:(await lstat(output)).size,sha256:hash.digest('hex')});
 };
 if(prepared.formatPlan)await save(prepared.formatPlan.artifactPath,prepared.formatPlan.artifactPath.split(/[\\/]/).at(-1));
 else {
  const walk=async(directory,prefix='')=>{
   for(const entry of await readdir(directory,{withFileTypes:true})) {
    const name=prefix?`${prefix}/${entry.name}`:entry.name,source=join(directory,entry.name);
    if(entry.isDirectory())await walk(source,name);
    else if(entry.isFile()&&/\.(dmg|exe|deb|rpm|AppImage)$/.test(entry.name))await save(source,name);
   }
  };
  await walk(join(native,'bundle'));
  // A macOS .app contains framework symlinks and extended metadata; ditto retains
  // the installable structure instead of copying its executable as a loose file.
  const app=join(native,'bundle/macos/PLUR1BUS.app');
  if(process.platform==='darwin'&&await lstat(app).then(m=>m.isDirectory()&&!m.isSymbolicLink()).catch(()=>false)){
   const archive=join(prepared.root,'PLUR1BUS.app.zip');
   await run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,archive]);
   await save(archive,'macos/PLUR1BUS.app.zip');
  }
 }
 if(!files.length)throw Error('native-artifacts-missing');
 await copyFile(prepared.manifestPath,join(destination,'bundle.json'));
 await copyFile(join(prepared.root,'resources/payload.json'),join(destination,'payload.json'));
 const provenance={schema:'desktop.package-artifacts/1',target,channel,variant,distribution,fixture:prepared.provenance.fixture,unsigned:true,nativeInstallValidated:false,...(distribution==='flatpak'?{runtimeAbiValidated:false,runtime:'org.gnome.Platform/49'}:{}),files};
 await writeFile(join(destination,'artifacts.json'),JSON.stringify(provenance,null,2)+'\n');
 return destination;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),flags={};
 while(args.length){const key=args.shift();if(key==='--ci-fixture')flags.ciFixture=true;else if(key==='--execute-formats')flags.executeFormats=true;else if(['--target','--variant','--channel','--distribution','--artifact-root'].includes(key)&&args.length)flags[key.slice(2)]=args.shift();else throw Error('invalid-packaging-argument');}
 await buildBundle({...flags,channel:flags.channel??'beta',distribution:flags.distribution??'direct',artifactRoot:flags['artifact-root'],bundleInput:process.env.PLUR1BUS_DESKTOP_RELEASE_MANIFEST,cliPath:process.env.PLUR1BUS_DESKTOP_HOST_CLI,snapshotNodeArchive:process.env.PLUR1BUS_DESKTOP_SNAPSHOT_NODE_ARCHIVE,applePkgPath:process.env.PLUR1BUS_DESKTOP_APPLE_PKG,imagePath:process.env.PLUR1BUS_DESKTOP_OFFLINE_IMAGE,modelsDir:process.env.PLUR1BUS_DESKTOP_OFFLINE_MODELS,signingIdentity:process.env.APPLE_SIGNING_IDENTITY}).then(r=>console.log(JSON.stringify({manifestPath:r.manifestPath,configPath:r.configPath,fixture:r.provenance.fixture}))).catch(()=>{console.error('DESKTOP_NATIVE_PACKAGING_FAILED');process.exitCode=1;});
}
