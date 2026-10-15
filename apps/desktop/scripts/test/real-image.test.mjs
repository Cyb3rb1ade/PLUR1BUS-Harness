import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imagePlan,inspectOwned,imageMatches,missingContract,CONTRACTS,probe,parseArgs} from '../real-image-probe.mjs';
const digest='a'.repeat(64), token='0123456789abcdef01234567', image=`localhost/plur1bus@sha256:${digest}`;
const result=(stdout='',code=0,stderr='')=>({stdout,code,stderr,timedOut:false,overflow:false});

test('plans accept immutable references and exact local IDs but never floating tags or arbitrary names',()=>{
  for(const runtime of ['apple','docker','podman']) {
    const p=imagePlan({runtime,image,token});
    for(const name of [p.init,p.main,p.models,p.state])assert.match(name,/^p1t-d1-[a-f0-9]{24}-(init|main|models|state)$/);
    assert(p.mainCreate.includes('10001:10001'));
    assert(p.mainCreate.includes('--read-only'));
    assert(p.mainCreate.includes(`${p.models}:/state/models`));
    assert(p.initCreate.includes('0:0'));
    assert.equal(p.initSetup.at(-1),'chown 10001:10001 /state /state/models && chmod 0700 /state /state/models');
    assert(p.mainCreate.includes(image));
    assert.throws(()=>imagePlan({runtime,image:'plur1bus:latest',token}),/IMMUTABLE/);
  }
  assert.equal(imagePlan({runtime:'docker',image:`sha256:${digest}`,token}).imageIdentity,'local-config-id');
  assert.throws(()=>imagePlan({runtime:'apple',image:`sha256:${digest}`,token}),/IMMUTABLE/);
  assert.throws(()=>imagePlan({runtime:'docker',image,token:'existing-user-object'}),/TOKEN/);
  assert.throws(()=>parseArgs(['--image',image,'--runtime','docker']),/ARGUMENTS/);
});
test('immutable image identity must match actual inspect, local IDs do not need registry RepoDigests',()=>{
  const local=imagePlan({runtime:'docker',image:`sha256:${digest}`,token});
  assert(imageMatches(JSON.stringify([{Id:local.image,RepoDigests:[]}]),local));
  assert(!imageMatches(JSON.stringify([{Id:`sha256:${'b'.repeat(64)}`}]),local));
  const apple=imagePlan({runtime:'apple',image,token});
  assert(imageMatches(JSON.stringify([{configuration:{descriptor:{digest:`sha256:${digest}`}}}]),apple));
});
test('cleanup ownership requires both exact per-run label values and unambiguous inspect document',()=>{
  const p=imagePlan({runtime:'docker',image,token});
  assert(inspectOwned(JSON.stringify([{Config:{Labels:{...p.labels,'org.opencontainers.image.title':'fixture'}}}]),p.labels,'docker'));
  assert(!inspectOwned(JSON.stringify([{Config:{Labels:{...p.labels,'app.plur1bus.acceptance-run':'foreign'}}}]),p.labels,'docker'));
  assert(!inspectOwned('{}',p.labels,'docker'));assert(!inspectOwned('[]',p.labels,'docker'));
  assert(inspectOwned(JSON.stringify([{configuration:{labels:p.labels}}]),p.labels,'apple'));
});
test('help success alone cannot establish named command and option contracts',()=>{
  const contract=CONTRACTS[0];
  assert.equal(missingContract(contract,result('Usage: plur1bus device pair --kind --name --scope --grant')),null);
  assert.equal(missingContract(contract,result('Usage: plur1bus device pair')).reason,'required-options-missing');
  assert.equal(missingContract(contract,result('Usage: plur1bus device')).reason,'help-contract-mismatch');
  assert.equal(missingContract(contract,result('private error code=SECRET',2)).reason,'command-unavailable');
});
function runtimeMock({missing=[],foreignCleanup=false,daemonReady=true,imageMismatch=false}={}) {
  const calls=[],objects=new Map();const plan=imagePlan({runtime:'docker',image,token});
  const run=async(exe,args)=>{
    calls.push(args);
    if(args[0]==='image')return result(JSON.stringify([{RepoDigests:[imageMismatch?'wrong':image]}]));
    const volume=args[0]==='volume',op=volume?args[1]:args[0],name=volume?args[2]:args[1];
    if(op==='inspect') {
      const object=objects.get(name);
      if(!object)return result('',1,`No such object: ${name}`);
      const labels=foreignCleanup&&name===plan.main&&calls.some(a=>a[0]==='exec'&&a.includes('status'))?{...plan.labels,'app.plur1bus.acceptance-run':'foreign'}:plan.labels;
      return result(JSON.stringify([volume?{Labels:labels}:{Config:{Labels:labels}}]));
    }
    if(op==='create') {const name=volume?args.at(-1):args[args.indexOf('--name')+1];objects.set(name,{});return result();}
    if(op==='rm') {objects.delete(args.at(-1));return result();}
    if(op==='start')return result();
    if(op==='exec') {
      if(args.includes('id'))return result('10001\n');
      if(args.includes('/bin/sh'))return result();
      if(args.includes('--help')) {
        const c=CONTRACTS.find(c=>c.args.every((v,i)=>args[i+3]===v));
        if(!c)throw Error('mock contract mismatch');
        return missing.includes(c.id)?result('private SECRET',2):result(`Usage: plur1bus ${c.args.slice(0,-1).join(' ')} ${c.flags.join(' ')}`);
      }
      if(args.includes('status'))return result(JSON.stringify({children:[{role:'core',process:{state:daemonReady?'ready':'starting'}}]}));
    }
    throw Error('unmodeled runtime operation');
  };
  return {run,calls,objects};
}
test('injected runtime report records missing real contracts and never labels desktop/API acceptance passed',async()=>{
  const mock=runtimeMock({missing:['device.pair','state.restore']});
  const report=await probe({runtime:'docker',image,readinessAttempts:1},{run:mock.run,token});
  assert.equal(report.failure,null);assert.equal(report.daemonReady,true);assert.equal(report.cleanupVerified,true);
  assert.equal(report.fullDesktopApiGate,false);assert.equal(report.compatibility,false);
  assert.deepEqual(report.missingContracts,[{contract:'device.pair',reason:'command-unavailable'},{contract:'state.restore',reason:'command-unavailable'}]);
  assert.equal(mock.objects.size,0);assert(!JSON.stringify(report).includes('SECRET'));assert(!JSON.stringify(report).includes(image));
  assert(!mock.calls.some(a=>a.includes('--owner')||a.includes('--src')||a.includes('--grant')));
});
test('foreign object replacing owned container is preserved and cleanup remains unconfirmed',async()=>{
  const mock=runtimeMock({foreignCleanup:true});const report=await probe({runtime:'docker',image,readinessAttempts:1},{run:mock.run,token});
  assert.equal(report.failure,'CLEANUP_UNCONFIRMED');assert.equal(report.cleanupVerified,false);
  assert(!mock.calls.some(a=>a[0]==='rm'&&a.at(-1).endsWith('-main')));
});
test('image mismatch fails before creating any user runtime objects',async()=>{
  const mock=runtimeMock({imageMismatch:true});const report=await probe({runtime:'docker',image},{run:mock.run,token});
  assert.equal(report.failure,'IMAGE_IDENTITY_MISMATCH');assert.equal(report.imageVerified,false);
  assert(!mock.calls.some(a=>a.includes('create')));
});
test('Apple local tag fallback verifies digest and uses/removes only a new private image alias',async()=>{
  const pinned=`p1t-d1-build:test@sha256:${digest}`,source='p1t-d1-build:test';
  const objects=new Map(),images=new Set([source]),calls=[];
  const p=imagePlan({runtime:'apple',image:pinned,token});
  const run=async(exe,args)=>{
    calls.push(args);
    if(args[0]==='image') {
      if(args[1]==='inspect')return images.has(args[2])?result(JSON.stringify([{configuration:{descriptor:{digest:`sha256:${digest}`}}}])):result('',1,`image not found: ${args[2]}`);
      if(args[1]==='tag'){images.add(args[3]);return result();}
      if(args[1]==='delete'){images.delete(args[2]);return result();}
    }
    const volume=args[0]==='volume',op=volume?args[1]:args[0],name=volume?args[2]:args[1];
    if(op==='inspect')return objects.has(name)?result(JSON.stringify([{configuration:{labels:p.labels}}])):result('',1,`object not found: ${name}`);
    if(op==='create'){objects.set(volume?args.at(-1):args[args.indexOf('--name')+1],{});return result();}
    if(op==='delete'){objects.delete(args.at(-1));return result();}
    if(op==='start')return result();
    if(op==='exec') {
      if(args.includes('/bin/sh'))return result();if(args.includes('id'))return result('10001');
      if(args.includes('--help'))return result('',2);
      if(args.includes('status'))return result(JSON.stringify({children:[{role:'core',process:{state:'ready'}}]}));
    }
    throw Error('unmodeled Apple operation');
  };
  const report=await probe({runtime:'apple',image:pinned,readinessAttempts:1},{run,token});
  assert.equal(report.failure,null);assert.equal(report.imageIdentity,'verified-local-manifest-alias');assert.equal(report.cleanupVerified,true);
  assert.deepEqual([...images],[source]);assert.equal(objects.size,0);
  const created=calls.filter(a=>a[0]==='create');assert.equal(created.length,2);
  for(const args of created) {assert(!args.includes(source));assert(args.includes(`p1t-d1-${token}-image:pinned`));}
  assert(!calls.some(a=>a[0]==='image'&&a[1]==='delete'&&a[2]===source));
});
test('readiness failure stays explicit even when all help contracts exist',async()=>{
  const mock=runtimeMock({daemonReady:false});
  const report=await probe({runtime:'docker',image,readinessAttempts:1},{run:mock.run,token});
  assert.equal(report.failure,'DAEMON_NOT_READY');assert.equal(report.failureStage,'daemon-readiness');assert.equal(report.compatibility,false);assert.equal(report.cleanupVerified,true);
});
test('initializer releases both volume attachments before main startup',async()=>{
  const mock=runtimeMock();let mainStarted=false;
  const run=async(executable,args,timeout)=>{
    if(args[0]==='start'&&args[1].endsWith('-main')) {
      mainStarted=true;
      assert(![...mock.objects.keys()].some(name=>name.endsWith('-init')),'exclusive block volumes must be released before main starts');
    }
    return mock.run(executable,args,timeout);
  };
  const report=await probe({runtime:'docker',image,readinessAttempts:1},{run,token});
  assert.equal(mainStarted,true);assert.equal(report.failure,null);assert.equal(report.cleanupVerified,true);
  const initRemoval=mock.calls.findIndex(args=>args[0]==='rm'&&args.at(-1).endsWith('-init'));
  const mainCreate=mock.calls.findIndex(args=>args[0]==='create'&&args.includes(`p1t-d1-${token}-main`));
  assert(initRemoval>=0&&initRemoval<mainCreate);
});
