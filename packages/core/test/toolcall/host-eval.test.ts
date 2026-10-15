import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostEvalGate, reportLabel, HOST_EVAL_SUITE, HOST_SCENARIO_IDS, type HostEvalReport } from '../../src/toolcall/host-eval.ts';
const report = (passed: number, evidence: HostEvalReport['evidence'] = 'recorded'): HostEvalReport => ({ schema: 'plur1bus.host-tool-eval/1', suite: HOST_EVAL_SUITE, provider: 'fixture', model: 'default', evidence, generatedAt: new Date().toISOString(), status: 'completed', scenarios: Array.from({length:20},(_,i)=>({id:HOST_SCENARIO_IDS[i]!,passed:i<passed,policyEscapes:0})), successRate: passed/20, policyEscapes:0 });
test('95% gate is per default model and never averages, fakes or accepts empty coverage', () => {
  assert.equal(reportLabel(report(19)), 'supported'); assert.equal(reportLabel(report(18)), 'limited tool use');
  assert.equal(reportLabel(report(20,'fake')), 'unknown');
  assert.equal(hostEvalGate([],[]).passed,false);
  assert.equal(hostEvalGate([{provider:'fixture',model:'default'},{provider:'other',model:'default'}],[report(20)]).passed,false);
  assert.equal(hostEvalGate([{provider:'fixture',model:'default'}],[report(19)]).passed,true);
  assert.equal(reportLabel({...report(19),successRate:1}), 'unknown');
  const escaped=report(20); escaped.scenarios[0]!.policyEscapes=1; escaped.policyEscapes=1; assert.equal(reportLabel(escaped),'limited tool use');
});
test('20 host scenarios exercise scratch files, policy refusals and approved fake host ports', async () => {
  const {runHostEval,HOST_SCENARIOS}=await import('../../src/toolcall/host-eval.ts');
  const {hostHarness}=await import('./host-harness.ts');
  const result=await runHostEval(HOST_SCENARIOS,{provider:'fixture',model:'host-regression'},async i=>structuredClone(HOST_SCENARIOS.find(s=>s.id===i.id)!.transcript),hostHarness);
  assert.deepEqual(result.scenarios.filter(s=>!s.passed),[]); assert.equal(result.successRate,1); assert.equal(result.policyEscapes,0);
  assert.equal(reportLabel(result),'unknown');
});
test('report storage refuses stale, oversized, incomplete and mismatched corpus evidence', async () => {
  const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const {readHostEvalReports,modelToolUse}=await import('../../src/toolcall/host-eval-store.ts');
  const dir=await mkdtemp(join(tmpdir(),'d106-report-')); try {
    await mkdir(join(dir,'state','tool-eval'),{recursive:true}); const file=join(dir,'state','tool-eval','host-reports.json');
    await writeFile(file,JSON.stringify([report(18)])); assert.equal(await modelToolUse(dir,'fixture','default'),'limited tool use');
    await writeFile(file,JSON.stringify([{...report(20),suite:'old-suite'}])); assert.equal(await modelToolUse(dir,'fixture','default'),'unknown');
    await writeFile(file,JSON.stringify([{...report(20),generatedAt:new Date(Date.now()-8*86400000).toISOString()}])); assert.deepEqual(await readHostEvalReports(dir),[]);
    await writeFile(file,' '.repeat(1024*1024+1)); assert.deepEqual(await readHostEvalReports(dir),[]);
    await writeFile(file,'[{"provider":"x","model":"y","scenarios":null}]'); assert.deepEqual(await readHostEvalReports(dir),[]);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('nightly CLI drives provider tool calls without narrowing independent release coverage', async () => {
  const {createServer}=await import('node:http'); const {execFile}=await import('node:child_process'); const {promisify}=await import('node:util');
  const {mkdtemp,readFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path'); const {fileURLToPath}=await import('node:url');
  const {HOST_SCENARIOS}=await import('../../src/toolcall/host-eval.ts');
  const dir=await mkdtemp(join(tmpdir(),'d106-cli-')); let calls=0;
  const paths: string[] = [];
  const server=createServer(async(req,res)=>{
    let body=''; for await(const c of req)body+=c;
    const raw=JSON.parse(body); const scenario=HOST_SCENARIOS.find(s=>JSON.stringify(raw).includes(JSON.stringify(s.prompt).slice(1,-1)))!;
    calls++; paths.push(req.url!);
    const tools=scenario.transcript.map((c,i)=>({id:String(i),name:c.name.replaceAll('.', '_'),args:c.args}));
    const result=req.url!.endsWith('/messages')
      ?{id:'msg_fixture',type:'message',role:'assistant',model:raw.model,content:tools.map(c=>({type:'tool_use',id:c.id,name:c.name,input:c.args})),stop_reason:'tool_use',usage:{input_tokens:1,output_tokens:1}}
      :req.url!.endsWith('/responses')
      ?{id:'resp_fixture',object:'response',status:'completed',model:raw.model,output:tools.map(c=>({type:'function_call',id:'fc_'+c.id,call_id:c.id,name:c.name,arguments:JSON.stringify(c.args)}))}
      :req.url!.includes(':generateContent')
      ?{candidates:[{content:{role:'model',parts:tools.map(c=>({functionCall:{name:c.name,args:c.args}}))},finishReason:'STOP'}]}
      :{id:'fixture-response',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:tools.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))},finish_reason:'tool_calls'}]};
    res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const port=(server.address() as {port:number}).port;
    const run=promisify(execFile);
    await run(process.execPath,['--experimental-strip-types','--conditions=source','--no-warnings=ExperimentalWarning',fileURLToPath(new URL('../../../../scripts/eval/tool-eval-host.ts',import.meta.url)),'--live'],{env:{...process.env,D106_TEST_CREDENTIAL:'fixture',PLUR1BUS_HOST_EVAL_OUT:dir,PLUR1BUS_HOST_EVAL_MODELS:JSON.stringify(['chat_completions','anthropic_messages','codex_responses','gemini'].map(wireFormat=>({provider:'fixture',model:wireFormat,wireFormat,baseUrl:`http://127.0.0.1:${port}/v1`,keyEnv:'D106_TEST_CREDENTIAL'})))},timeout:30000});
    assert.equal(calls,80);
    for(const suffix of ['/chat/completions','/messages','/responses',':generateContent'])assert.equal(paths.filter(p=>p.endsWith(suffix)).length,20);
    const reports=JSON.parse(await readFile(join(dir,'host-reports.json'),'utf8'));
    assert.equal(reports.length,4); for(const report of reports)assert.equal(report.successRate,1); assert.equal(reports[0].baseUrl,undefined); assert.equal(reports[0].keyEnv,undefined);
    const gate=JSON.parse(await readFile(join(dir,'gate.json'),'utf8')); assert.equal(gate.passed,false);
    const captures=JSON.parse(await readFile(join(dir,'host-eval-recordings.json'),'utf8'));
    assert.equal(captures.models.length,4); assert.ok(captures.models.every((m:{transcripts:unknown[]})=>m.transcripts.length===20));
    assert.ok(!JSON.stringify(captures).includes('D106_TEST_CREDENTIAL'));
  } finally {await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
