import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const OWNER = 'app.plur1bus.acceptance';
const RUN = 'app.plur1bus.acceptance-run';
export const CONTRACTS = [
  {id:'device.pair', args:['device','pair','--help'], flags:['--kind','--name','--scope','--grant']},
  {id:'user.create', args:['user','create','--help'], flags:['--owner']},
  {id:'state.snapshot', args:['state','snapshot','--help'], flags:['--src','--dst']},
  {id:'state.verify', args:['state','verify','--help'], flags:['--dir']},
  {id:'state.restore', args:['state','restore','--help'], flags:['--src','--dst']},
  {id:'admin.smoke', args:['admin','smoke','--help'], flags:[]},
];
function fail(code) { throw new Error(code); }
export function imagePlan({runtime,image,token=randomBytes(12).toString('hex')}) {
  if (!['apple','docker','podman'].includes(runtime)) fail('INVALID_RUNTIME');
  const registryDigest=/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image ?? '');
  const localId=/^sha256:[a-f0-9]{64}$/.test(image ?? '');
  if (!registryDigest && !(localId && runtime !== 'apple')) fail('IMMUTABLE_IMAGE_REQUIRED');
  if (!/^[a-f0-9]{24}$/.test(token)) fail('INVALID_TOKEN');
  const base=`p1t-d1-${token}`;
  const labels={[OWNER]:'real-image-probe',[RUN]:token};
  const state=base+'-state', models=base+'-models', init=base+'-init', main=base+'-main';
  const labelArgs = Object.entries(labels).flatMap(([k,v]) => [runtime === 'apple' ? '-l' : '--label',`${k}=${v}`]);
  const common=['--read-only','--tmpfs','/tmp','-v',`${state}:/state`,'-v',`${models}:/state/models`,...labelArgs];
  const create=(name,user,extra,command=[]) => ['create','--name',name,'--user',user,...common,...extra,image,...command];
  const restricted=runtime==='apple' ? ['-m','4096M','-c','2'] : ['--memory','4g','--cpus','2','--cap-drop','ALL','--security-opt','no-new-privileges:true'];
  return {runtime,image,imageIdentity:localId?'local-config-id':'registry-manifest-digest',labels,state,models,init,main,
    executable:runtime==='apple'?'/usr/local/bin/container':runtime,
    volumeCreate:name => ['volume','create',...(runtime==='apple'?['-s','8G']:[]),...Object.entries(labels).flatMap(([k,v])=>['--label',`${k}=${v}`]),name],
    initCreate:create(init,'0:0',['--network','none','--entrypoint','/bin/sleep'],['240']),
    initSetup:['exec',init,'/bin/sh','-c','chown 10001:10001 /state /state/models && chmod 0700 /state /state/models'],
    mainCreate:create(main,'10001:10001',restricted),
    inspect:(kind,name)=>kind==='volume'?['volume','inspect',name]:['inspect',name],
    remove:(kind,name)=>kind==='volume'?['volume',runtime==='apple'?'delete':'rm',name]:[runtime==='apple'?'delete':'rm','--force',name],
  };
}
export function inspectOwned(output, labels, runtime) {
  let rows; try {rows=JSON.parse(output);} catch {return false;}
  if (!Array.isArray(rows) || rows.length!==1) return false;
  const observed=runtime==='apple'?rows[0]?.configuration?.labels:rows[0]?.Config?.Labels??rows[0]?.Labels;
  return observed && Object.entries(labels).every(([k,v])=>observed[k]===v) || false;
}
export function imageMatches(output,plan) {
  let rows;try {rows=JSON.parse(output);}catch{return false;}
  if(!Array.isArray(rows)||rows.length!==1)return false;
  if(plan.imageIdentity==='local-config-id')return rows[0]?.Id===plan.image;
  if(plan.runtime==='apple')return rows[0]?.configuration?.descriptor?.digest===plan.image.split('@')[1];
  return Array.isArray(rows[0]?.RepoDigests)&&rows[0].RepoDigests.includes(plan.image);
}
export function missingContract(contract,result) {
  if (result.code!==0 || result.timedOut || result.overflow) return {contract:contract.id,reason:'command-unavailable'};
  const output=result.stdout;
  const command=contract.args.slice(0,-1).join(' ');
  if (!output.includes('Usage:') || !output.includes(command)) return {contract:contract.id,reason:'help-contract-mismatch'};
  if (contract.flags.some(flag=>!output.includes(flag))) return {contract:contract.id,reason:'required-options-missing'};
  return null;
}
export function runBounded(executable,args,timeout=15000) {
  return new Promise(resolve => {
    let child; try {child=spawn(executable,args,{stdio:['ignore','pipe','pipe']});} catch {resolve({code:null,stdout:'',stderr:'',spawnFailed:true});return;}
    let stdout='',stderr='',timedOut=false,overflow=false,spawnFailed=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
    for (const [pipe,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']]) pipe.on('data',data=>{
      if (key==='stdout') stdout+=data; else stderr+=data;
      if (stdout.length+stderr.length>1048576) {overflow=true;stdout='';stderr='';child.kill('SIGKILL');}
    });
    child.once('error',()=>{spawnFailed=true;});
    child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut,overflow,spawnFailed});});
  });
}
function missingObject(result,name) {
  return result.code!==0 && !result.timedOut && !result.overflow && !result.spawnFailed && result.stderr.includes(name) && /not found|does not exist|no such (?:container|volume|object)/i.test(result.stderr);
}
function coreReady(stdout) {
  try {const d=JSON.parse(stdout);return Array.isArray(d?.children)&&d.children.some(c=>(c.role==='core'||c.kind==='core')&&c.process?.state==='ready');} catch {return false;}
}
export async function probe(options,{run=runBounded,sleep=delay,token}={}) {
  const plan=imagePlan({...options,token});
  const report={schema:1,runtime:plan.runtime,immutableImage:true,imageIdentity:plan.imageIdentity,imageVerified:false,compatibility:false,volumeOwnershipInitialized:false,nonroot10001:false,daemonStatusJson:false,daemonReady:false,missingContracts:[],cleanupVerified:false,fullDesktopApiGate:false,failure:null,failureStage:null};
  const attempted=[];let localAlias=null;let stage='image-identity';
  const invoke=(args,timeout)=>run(plan.executable,args,timeout);
  const checked=async(args,timeout)=>{const r=await invoke(args,timeout);if(r.code!==0||r.timedOut||r.overflow||r.spawnFailed) fail('RUNTIME_COMMAND_FAILED');return r;};
  const owned=async(kind,name)=>{const r=await checked(plan.inspect(kind,name));if(!inspectOwned(r.stdout,plan.labels,plan.runtime))fail('OWNERSHIP_MISMATCH');};
  const create=async(kind,name,args)=>{
    const existing=await invoke(plan.inspect(kind,name));
    if(!missingObject(existing,name))fail('OBJECT_ABSENCE_UNCONFIRMED');
    stage=kind==='volume'?'volume-create':name===plan.init?'setup-container-create':'main-container-create';
    attempted.push([kind,name]);
    await checked(args,60000);await owned(kind,name);
  };
  try {
    let inspected=await invoke(['image','inspect',plan.image]);
    if(inspected.code!==0&&plan.runtime==='apple') {
      // Apple local builds have only tag records. Bind a new private alias to the
      // caller-supplied manifest digest; never execute the mutable source tag.
      const source=plan.image.split('@')[0];
      if(!/^p1t-d1-[a-z0-9._-]+:[a-z0-9._-]+$/.test(source))fail('IMAGE_IDENTITY_MISMATCH');
      inspected=await checked(['image','inspect',source]);
      if(!imageMatches(inspected.stdout,plan))fail('IMAGE_IDENTITY_MISMATCH');
      const alias=`p1t-d1-${plan.labels[RUN]}-image:pinned`;
      const absent=await invoke(['image','inspect',alias]);
      if(!missingObject(absent,alias))fail('OBJECT_ABSENCE_UNCONFIRMED');
      localAlias=alias;
      await checked(['image','tag',source,alias]);
      inspected=await checked(['image','inspect',alias]);
      report.imageIdentity='verified-local-manifest-alias';
    }
    if(inspected.code!==0||!imageMatches(inspected.stdout,plan))fail('IMAGE_IDENTITY_MISMATCH');
    report.imageVerified=true;
    for(const name of [plan.state,plan.models]) await create('volume',name,plan.volumeCreate(name));
    await create('container',plan.init,plan.initCreate.map(v=>v===plan.image&&localAlias?localAlias:v));
    stage='setup-container-start';await checked(['start',plan.init],30000);
    await owned('volume',plan.state);await owned('volume',plan.models);await owned('container',plan.init);
    stage='volume-ownership-init';await checked(plan.initSetup);report.volumeOwnershipInitialized=true;
    // Apple's runtime volumes are block devices with an exclusive attachment.
    // Release the root-only initializer before starting the nonroot supervisor.
    stage='setup-container-disposal';await owned('container',plan.init);
    await checked(plan.remove('container',plan.init),30000);
    if(!missingObject(await invoke(plan.inspect('container',plan.init)),plan.init))fail('OBJECT_ABSENCE_UNCONFIRMED');
    await create('container',plan.main,plan.mainCreate.map(v=>v===plan.image&&localAlias?localAlias:v));
    stage='main-container-start';await checked(['start',plan.main],30000);
    stage='nonroot-check';const uid=await checked(['exec',plan.main,'id','-u']);
    report.nonroot10001=uid.stdout.trim()==='10001';
    if(!report.nonroot10001)fail('NONROOT_CHECK_FAILED');
    stage='contract-audit';for(const contract of CONTRACTS) {
      const result=await invoke(['exec',plan.main,'plur1bus',...contract.args]);
      const missing=missingContract(contract,result);if(missing)report.missingContracts.push(missing);
    }
    stage='daemon-readiness';const attempts=Number.isInteger(options.readinessAttempts)?Math.max(1,Math.min(options.readinessAttempts,30)):30;
    for(let i=0;i<attempts;i++) {
      const r=await invoke(['exec',plan.main,'plur1bus','--json','daemon','status'],10000);
      if(!r.timedOut&&!r.overflow&&!r.spawnFailed) {try {const json=JSON.parse(r.stdout);report.daemonStatusJson ||= json!==null&&typeof json==='object'&&!Array.isArray(json);} catch { /* only booleans leave process */ }}
      if(r.code===0&&coreReady(r.stdout)) {report.daemonReady=true;break;}
      if(i+1<attempts)await sleep(2000);
    }
    if(!report.daemonReady) {report.failure='DAEMON_NOT_READY';report.failureStage=stage;}
  } catch(error) {
    report.failureStage=stage;
    report.failure=['RUNTIME_COMMAND_FAILED','OWNERSHIP_MISMATCH','OBJECT_ABSENCE_UNCONFIRMED','NONROOT_CHECK_FAILED','IMAGE_IDENTITY_MISMATCH'].includes(error.message)?error.message:'PROBE_FAILED';
  } finally {
    let cleanup=true;
    for(const [kind,name] of attempted.toReversed()) {
      try {
        const before=await invoke(plan.inspect(kind,name));
        if(missingObject(before,name))continue;
        if(before.code!==0||!inspectOwned(before.stdout,plan.labels,plan.runtime)) {cleanup=false;continue;}
        const removal=await invoke(plan.remove(kind,name),30000);
        const after=await invoke(plan.inspect(kind,name));
        if(removal.code!==0||!missingObject(after,name))cleanup=false;
      } catch {cleanup=false;}
    }
    if(localAlias) {
      try {
        const current=await invoke(['image','inspect',localAlias]);
        if(current.code!==0||!imageMatches(current.stdout,plan))cleanup=false;
        else {
          const removed=await invoke(['image','delete',localAlias],30000);
          const after=await invoke(['image','inspect',localAlias]);
          if(removed.code!==0||!missingObject(after,localAlias))cleanup=false;
        }
      } catch {cleanup=false;}
    }
    report.cleanupVerified=cleanup;
    if(!cleanup)report.failure='CLEANUP_UNCONFIRMED';
  }
  report.compatibility=report.daemonReady&&report.missingContracts.length===0&&report.failure===null;
  return report;
}
export function parseArgs(args) {
  if(args.length!==6)fail('ARGUMENTS_INVALID');
  const result={};
  for(let i=0;i<args.length;i+=2) {const key=args[i];if(!['--image','--runtime','--report'].includes(key)||result[key.slice(2)]!==undefined)fail('ARGUMENTS_INVALID');result[key.slice(2)]=args[i+1];}
  if(!result.report)fail('ARGUMENTS_INVALID');imagePlan(result);return result;
}
async function main() {
  const options=parseArgs(process.argv.slice(2));
  const report=await probe(options);
  await writeFile(resolve(options.report),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report));
  if(report.failure)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(()=>{console.error('REAL_IMAGE_PROBE_FAILED');process.exitCode=1;});
