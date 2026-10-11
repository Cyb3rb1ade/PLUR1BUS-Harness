// Setup builds/prefetches outside this test. Acceptance contacts only the local Engine/registry.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir,networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {manifestDigests,manifestDigest,loopbackAddress,MANIFEST_ACCEPT} from './stub-digest.mjs';
export function containerPlan(runtime) {
 if(!['docker','podman'].includes(runtime))throw new Error('docker|podman required');
 return {runtime,registry:'registry:2',controller:`controller_e2e_${runtime}_stub_install_restart_stop_uninstall`,upgrade:['apps/desktop/scripts/upgrade-e2e.mjs',runtime,'--prebuilt']};
}
export function podmanRegistryConfig(address) {
 if(!/^127\.0\.0\.1:\d+$/.test(address))throw new Error('Loopback registry required');
 return `[[registry]]\nlocation = "${address}"\ninsecure = true\n`;
}
async function run(runtime,dry) {
 const plan=containerPlan(runtime);
 if(dry){console.log(JSON.stringify(plan,null,2));return;}
 if(process.env.PLUR1BUS_DESKTOP_E2E_RUNTIME!==runtime)throw new Error('Explicit runtime opt-in required');
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 function cli(args,timeout=30000){const r=spawnSync(runtime,args,{encoding:'utf8',timeout});if(r.error)throw r.error;if(r.status!==0)throw new Error(`${runtime} ${args[0]}: ${r.stderr.slice(-2000)}`);return r.stdout.trim();}
 function cargo(test,name,env){const r=spawnSync('cargo',['test','--offline','--locked','-p','plur1bus-desktop','--test',test,name,'--','--ignored','--exact','--nocapture'],{cwd:join(root,'apps/desktop'),stdio:'inherit',timeout:900000,env:{...process.env,...env}});if(r.error)throw r.error;if(r.status!==0)throw new Error(`${name} failed; retain synthetic engine objects for diagnosis`);}
 const scratch=mkdtempSync(join(tmpdir(),'p1t-wp14-'));let service;let registry;let registryTag;let registryPin;let stub;
 try {
  let endpoint=process.env.PLUR1BUS_DESKTOP_E2E_ENDPOINT;
  if(!endpoint&&runtime==='docker')endpoint=cli(['context','inspect','--format','{{.Endpoints.docker.Host}}']);
  if(!endpoint){endpoint=`unix://${join(scratch,'engine.sock')}`;service=spawn(runtime,['system','service','--time=0',endpoint],{stdio:'ignore'});await delay(1000);}
  if(!endpoint.startsWith('unix://')&&!endpoint.startsWith('npipe:'))throw new Error('Local socket required');
  const stubTag='p1t-stub-harness:wp11-0.1.0';
  cli(['image','inspect',stubTag]);
  // Manifest digest (RepoDigest), not the image ID: that is what the bundle pins and image_present looks up.
  stub=await manifestDigests(runtime,[stubTag],plan.registry);
  const [digest]=stub.digests;
  const ips=Object.values(networkInterfaces()).flat().filter(v=>v&&!v.internal&&v.family==='IPv4').map(v=>v.address);
  if(!ips.length)throw new Error('Non-loopback IPv4 required for exposure check');
  const env={PLUR1BUS_DESKTOP_E2E_ENDPOINT:endpoint,PLUR1BUS_DESKTOP_E2E_STUB_DIGEST:digest,PLUR1BUS_DESKTOP_E2E_NON_LOOPBACK:ips.join(',')};
  const upgraded=spawnSync(process.execPath,plan.upgrade,{cwd:root,stdio:'inherit',timeout:3000000,env:{...process.env,...env}});
  if(upgraded.error)throw upgraded.error;if(upgraded.status!==0)throw new Error('Upgrade acceptance failed');
  // An isolated preloaded registry proves digest retrieval without contacting a public registry.
  registry=`p1t-registry-${randomUUID()}`;
  cli(['image','inspect',plan.registry]);
  cli(['run','--detach','--name',registry,'--label',`app.plur1bus.test=${registry}`,'--tmpfs','/var/lib/registry','--publish','127.0.0.1::5000',plan.registry]);
  const address=loopbackAddress(cli(['port',registry,'5000/tcp']));
  for(let n=0;n<40;n++){try{if((await fetch(`http://${address}/v2/`)).ok)break;}catch{}if(n===39)throw new Error('Registry unavailable');await delay(250);}
  const ref=`${address}/p1t-stub-harness`;
  registryTag=`${ref}:wp14`;
  cli(['tag',stubTag,registryTag]);
  cli(['push',...(runtime==='podman'?['--tls-verify=false']:[]),`${ref}:wp14`],120000);
  const manifest=await fetch(`http://${address}/v2/p1t-stub-harness/manifests/wp14`,{headers:{Accept:MANIFEST_ACCEPT}});
  if(!manifest.ok)throw new Error('Registry manifest unavailable');
  const hash=manifestDigest(manifest.headers.get('docker-content-digest'));
  cli(['image','rm',registryTag]);registryTag=null;
  if(service) {
   service.kill('SIGTERM');await new Promise(resolve=>service.once('exit',resolve));
   const config=join(scratch,'registries.conf');
   writeFileSync(config,podmanRegistryConfig(address));
   service=spawn(runtime,['system','service','--time=0',endpoint],{stdio:'ignore',env:{...process.env,CONTAINERS_REGISTRIES_CONF:config}});
   await delay(1000);
  }
  registryPin=`${ref}@${hash}`;
  cargo('controller_e2e','controller_e2e_local_registry_pull_by_digest',{...env,PLUR1BUS_DESKTOP_E2E_REGISTRY:ref,PLUR1BUS_DESKTOP_E2E_REGISTRY_DIGEST:hash});
  cli(['image','rm',registryPin]);registryPin=null;
  cargo('controller_e2e',plan.controller,env);
  console.log(`PASS: ${runtime} controller, pairing/upgrade/rollback, local digest pull and loopback restriction`);
 } finally {
  stub?.cleanup();
  for(const alias of [registryTag,registryPin])if(alias)spawnSync(runtime,['image','rm',alias],{stdio:'ignore',timeout:30000});
  if(registry)cli(['rm','--force',registry]);
  if(service&&service.exitCode===null){service.kill('SIGTERM');await new Promise(resolve=>service.once('exit',resolve));}
  rmSync(scratch,{recursive:true,force:true});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await run(process.argv[2],process.argv.includes('--dry-run'));
