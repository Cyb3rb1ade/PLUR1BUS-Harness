// Explicit opt-in. Images are built locally and never published; only synthetic test namespaces are used.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const engine=process.argv[2];
if(!['docker','podman'].includes(engine)||process.env.PLUR1BUS_DESKTOP_E2E_RUNTIME!==engine)throw new Error('Set PLUR1BUS_DESKTOP_E2E_RUNTIME=docker|podman and pass that runtime');
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
function cli(argv,timeout=30000){const r=spawnSync(engine,argv,{cwd:root,encoding:'utf8',timeout});if(r.status!==0)throw new Error(`${engine} ${argv[0]} failed: ${r.stderr?.slice(-2000)}`);return r.stdout.trim();}
let ownedService;let scratch;
try{
 let endpoint=process.env.PLUR1BUS_DESKTOP_E2E_ENDPOINT;
 if(!endpoint&&engine==='docker')endpoint=cli(['context','inspect','--format','{{.Endpoints.docker.Host}}']);
 if(!endpoint&&engine==='podman'){
  scratch=mkdtempSync(join(tmpdir(),'p1t-upgrade-socket-'));endpoint=`unix://${join(scratch,'engine.sock')}`;
  ownedService=spawn(engine,['system','service','--time=0',endpoint],{stdio:'ignore'});
  await delay(1000);
 }
 if(!endpoint?.startsWith('unix://')&&!endpoint?.startsWith('npipe:'))throw new Error('Local unix/npipe endpoint required');
 const digests=[];
 for(const [version,failure]of [['0.1.0','0'],['0.1.1','0'],['0.1.2','1']]){
  const tag=`p1t-stub-harness:wp11-${version}`;
  cli(['build','--file','stub-image/Dockerfile','--build-arg',`STUB_VERSION=${version}`,'--build-arg',`STUB_FAIL_SMOKE=${failure}`,'--tag',tag,'.'],900000);
  digests.push(cli(['image','inspect','--format','{{.Id}}',tag]));
 }
 const result=spawnSync('cargo',['test','--locked','-p','plur1bus-desktop','--test','upgrade_e2e',`upgrade_e2e_${engine}`,'--','--ignored','--exact','--nocapture'],{cwd:root,stdio:'inherit',timeout:900000,env:{...process.env,PLUR1BUS_DESKTOP_E2E_ENDPOINT:endpoint,PLUR1BUS_DESKTOP_UPGRADE_DIGESTS:digests.join(',')}});
 if(result.error)throw result.error;if(result.status!==0)throw new Error('upgrade acceptance failed; synthetic evidence is retained');
 console.log(`PASS: ${engine} A → B → failing B′ → rollback to B; device token and synthetic persisted state survive`);
}finally{if(ownedService)ownedService.kill('SIGTERM');if(scratch)rmSync(scratch,{recursive:true,force:true});}
