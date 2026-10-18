// Explicit native packaging entry point. Staging never installs or signs with repo credentials.
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,copyFile} from 'node:fs/promises';
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
 // The sidecar is a real host helper even when the optional user CLI is an inert fixture.
 await run('cargo',['build','--locked','--release','--target',options.target,'-p','plur1bus-host']);
 await mkdir(join(desktop,'src-tauri/binaries'),{recursive:true});
 await copyFile(join(desktop,'target',options.target,'release',`plur1bus-host${suffix}`),join(desktop,'src-tauri/binaries',`plur1bus-host-${options.target}${suffix}`));
 const args=[join(desktop,'node_modules/@tauri-apps/cli/tauri.js'),'build','--target',options.target,'--config',prepared.configPath];
 if(options.channel==='dev')args.push('--debug');
 if(options.distribution==='store'||options.distribution==='flatpak')args.push('--config',join(desktop,'src-tauri/tauri.store.conf.json'),'--features','store','--no-bundle');

 else args.push('--bundles',prepared.bundles.join(','));
 args.push('--','--locked');
 if(options.distribution==='store'||options.distribution==='flatpak')args.push('--no-default-features');
 await run(process.execPath,args,{...process.env,PLUR1BUS_DESKTOP_BUNDLE_MANIFEST:prepared.manifestPath,PLUR1BUS_DESKTOP_BUILD_CHANNEL:options.channel,...(options.ciFixture?{PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY:'1'}:{})});
 if(options.distribution==='store'||options.distribution==='flatpak'){
  const native=join(desktop,'target',options.target,options.channel==='dev'?'debug':'release');
  const plan=await stagePackageFormat({format:options.distribution==='store'?'msix':'flatpak',target:options.target,variant:options.variant,outDir:join(stage,'format'),binaryPath:join(native,`plur1bus-desktop${suffix}`),helperPath:join(native,`plur1bus-host${suffix}`),resourcesDir:join(prepared.root,'resources'),iconsDir:join(desktop,'src-tauri',options.distribution==='store'?'packaging-assets/msix':'icons'),version:'0.1.0',storeBuild:true,publisher:process.env.PLUR1BUS_MSIX_PUBLISHER,identityName:process.env.PLUR1BUS_MSIX_IDENTITY,execute:options.executeFormats===true});
  prepared.formatPlan=plan;
 }
 return prepared;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),flags={};
 while(args.length){const key=args.shift();if(key==='--ci-fixture')flags.ciFixture=true;else if(key==='--execute-formats')flags.executeFormats=true;else if(['--target','--variant','--channel','--distribution'].includes(key)&&args.length)flags[key.slice(2)]=args.shift();else throw Error('invalid-packaging-argument');}
 await buildBundle({...flags,channel:flags.channel??'beta',distribution:flags.distribution??'direct',bundleInput:process.env.PLUR1BUS_DESKTOP_RELEASE_MANIFEST,cliPath:process.env.PLUR1BUS_DESKTOP_HOST_CLI,applePkgPath:process.env.PLUR1BUS_DESKTOP_APPLE_PKG,imagePath:process.env.PLUR1BUS_DESKTOP_OFFLINE_IMAGE,modelsDir:process.env.PLUR1BUS_DESKTOP_OFFLINE_MODELS,signingIdentity:process.env.APPLE_SIGNING_IDENTITY}).then(r=>console.log(JSON.stringify({manifestPath:r.manifestPath,configPath:r.configPath,fixture:r.provenance.fixture}))).catch(()=>{console.error('DESKTOP_NATIVE_PACKAGING_FAILED');process.exitCode=1;});
}
