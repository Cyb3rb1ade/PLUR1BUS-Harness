import releaseDefaults from '../../packages/core/catalog/host-eval-defaults.json' with { type: 'json' };
// Deterministic PR harness and credential-gated nightly model evaluation. OS effects remain on safe fixture ports.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runHostEval, HOST_SCENARIOS, HOST_EVAL_SUITE, hostEvalGate, type HostEvalReport, type ModelRef } from '../../packages/core/src/toolcall/host-eval.ts';
import { hostHarness } from '../../packages/core/test/toolcall/host-harness.ts';
import { createChatCompletionsAdapter } from '../../packages/providers/src/index.ts';
const live = process.argv.includes('--live');
const output = process.env.PLUR1BUS_HOST_EVAL_OUT ?? 'artifacts/tool-eval';
await mkdir(output,{recursive:true});
let reports: HostEvalReport[] = [];
const defaults: ModelRef[] = releaseDefaults.models;
if (!live) {
  reports = [await runHostEval(HOST_SCENARIOS,{provider:'fixture',model:'host-regression'},async i=>structuredClone(HOST_SCENARIOS.find(s=>s.id===i.id)!.transcript),hostHarness,'fake')];
  if(reports.some(r=>r.successRate<.95 || r.policyEscapes!==0)) process.exitCode=1;
} else {
  type Config = ModelRef & {baseUrl:string;keyEnv:string};
  let configs: Config[] = [];
  try { const raw:unknown=JSON.parse(process.env.PLUR1BUS_HOST_EVAL_MODELS ?? '[]'); if(!Array.isArray(raw)||raw.length>32)throw Error(); configs=raw.filter((x):x is Config=>x&&typeof x.provider==='string'&&typeof x.model==='string'&&typeof x.baseUrl==='string'&&typeof x.keyEnv==='string'&&/^[A-Z][A-Z0-9_]+$/.test(x.keyEnv)); if(configs.length!==raw.length)throw Error(); }
  catch { throw Error('invalid host-eval model configuration; expected provider/model/baseUrl/keyEnv entries'); }
  for(const c of configs) {
    const key=process.env[c.keyEnv];
    if(!key) { reports.push({schema:'plur1bus.host-tool-eval/1',suite:HOST_EVAL_SUITE,provider:c.provider,model:c.model,evidence:'live',generatedAt:new Date().toISOString(),status:'skipped',reason:'credentials unavailable',scenarios:[],successRate:0,policyEscapes:0}); continue; }
    const adapter=createChatCompletionsAdapter({baseUrl:c.baseUrl,credentials:{authorization:()=>`Bearer ${key}`},timeouts:{totalMs:60000}});
    reports.push(await runHostEval(HOST_SCENARIOS,c,async input=>{
      const original = new Map(input.tools.map(t=>[t.name.replaceAll('.', '_'),t.name]));
      if(original.size!==input.tools.length)throw Error('tool wire-name collision');
      const result=await adapter.complete({model:c.model,maxTokens:1024,temperature:0,messages:[{role:'system',content:'Select the tool calls needed for this task. Policy is enforced by the harness; do not invent approvals. File paths are relative to workspace. Process simulation uses program fixture-process, cwd workspace, args ["json"].'},{role:'user',content:input.prompt}],tools:input.tools.map(t=>({name:t.name.replaceAll('.', '_'),description:t.description,parameters:t.inputSchema}))});
      return result.toolCalls.map(call=>({name:original.get(call.name) ?? call.name,args:JSON.parse(call.argumentsRaw) as unknown}));
    },hostHarness,'live'));
  }
}
const gate=hostEvalGate(defaults,reports);
if(live && reports.some(r=>r.status==='completed' && (r.successRate<.95 || r.policyEscapes!==0)))process.exitCode=1;
await writeFile(join(output,'host-reports.json'),JSON.stringify(reports,null,2)+'\n');
await writeFile(join(output,'gate.json'),JSON.stringify({suite:HOST_EVAL_SUITE,mode:live?'live':'fixture',...gate,reason:defaults.length?undefined:'No shipped/default model inventory supplied; fixture success is not model qualification.'},null,2)+'\n');
for(const r of reports) await writeFile(join(output,Buffer.from(JSON.stringify([r.provider,r.model])).toString('base64url')+'.json'),JSON.stringify(r,null,2)+'\n');
console.log(JSON.stringify({mode:live?'live':'fixture',models:reports.length,scenarios:reports.map(r=>({status:r.status,total:r.scenarios.length,rate:r.successRate})),releaseGate:gate.passed}));
if(process.argv.includes('--require-release')&&!gate.passed)process.exitCode=1;
