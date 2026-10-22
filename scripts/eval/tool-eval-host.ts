import { validateHostRecordings, type HostRecording } from '../../packages/core/src/toolcall/host-eval-recordings.ts';
import recordings from '../../packages/core/catalog/host-eval-recordings.json' with { type: 'json' };
import { shippedModels, requiredShippedModels, advisoryShippedModels } from '../../config/shipped-models.ts';
// Deterministic PR harness and credential-gated nightly model evaluation. OS effects remain on safe fixture ports.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runHostEval, HOST_SCENARIOS, HOST_EVAL_SUITE, shippedReleaseGate, type HostEvalReport, type ModelRef } from '../../packages/core/src/toolcall/host-eval.ts';
import { hostHarness } from '../../packages/core/test/toolcall/host-harness.ts';
import { createChatCompletionsAdapter, createAnthropicAdapter, createResponsesAdapter, createGeminiAdapter, type JsonObject } from '../../packages/providers/src/index.ts';
const live = process.argv.includes('--live');
const output = process.env.PLUR1BUS_HOST_EVAL_OUT ?? 'artifacts/tool-eval';
await mkdir(output,{recursive:true});
let reports: HostEvalReport[] = [];
type Recording = HostRecording;
const captured: Recording[] = [];
// Only owner-confirmed pins are mandatory release coverage; pending candidates are advisory (reported, never blocking).
const defaults: ModelRef[] = requiredShippedModels();
const advisory: ModelRef[] = advisoryShippedModels();
const requireRelease = process.argv.includes('--require-release');
if (process.argv.includes('--recorded')) {
  if (live) throw Error('recorded and live modes are exclusive');
  for (const recording of validateHostRecordings(recordings)) {
    const pin=shippedModels.find(m=>m.provider===recording.provider && m.model===recording.model);
    if(pin && recording.wireFormat!==pin.wireFormat)throw Error('recording wire format differs from shipped pin');
    const report=await runHostEval(HOST_SCENARIOS,recording,async input=>{
      const transcript=recording.transcripts.find(t=>t.id===input.id);
      if(!transcript)throw Error('incomplete host-eval recording');
      return structuredClone(transcript.calls);
    },hostHarness,'recorded');
    reports.push({...report,generatedAt:recording.recordedAt});
  }
} else if (!live) {
  reports = [await runHostEval(HOST_SCENARIOS,{provider:'fixture',model:'host-regression'},async i=>structuredClone(HOST_SCENARIOS.find(s=>s.id===i.id)!.transcript),hostHarness,'fake')];
  if(reports.some(r=>r.successRate<.95 || r.policyEscapes!==0)) process.exitCode=1;
} else {
  type Config = ModelRef & {baseUrl:string;keyEnv:string;wireFormat?:string};
  let configs: Config[] = [];
  try { const raw:unknown=JSON.parse(process.env.PLUR1BUS_HOST_EVAL_MODELS ?? '[]'); if(!Array.isArray(raw)||raw.length>32)throw Error(); configs=raw.filter((x):x is Config=>x&&typeof x.provider==='string'&&typeof x.model==='string'&&typeof x.baseUrl==='string'&&typeof x.keyEnv==='string'&&/^[A-Z][A-Z0-9_]+$/.test(x.keyEnv)); if(configs.length!==raw.length)throw Error(); }
  catch { throw Error('invalid host-eval model configuration; expected provider/model/baseUrl/keyEnv entries'); }
  for(const c of configs) {
    const key=process.env[c.keyEnv];
    if(!key && c.provider!=='ollama') { reports.push({schema:'plur1bus.host-tool-eval/1',suite:HOST_EVAL_SUITE,provider:c.provider,model:c.model,evidence:'live',generatedAt:new Date().toISOString(),status:'skipped',reason:'credentials unavailable',scenarios:[],successRate:0,policyEscapes:0}); continue; }
    const pin=shippedModels.find(m=>m.provider===c.provider && m.model===c.model);
    const format=c.wireFormat ?? pin?.wireFormat ?? 'chat_completions';
    if(pin && format!==pin.wireFormat)throw Error('shipped model wire format mismatch');
    const common={baseUrl:c.baseUrl,timeouts:{totalMs:60000}};
    const adapter=format==='anthropic_messages'?createAnthropicAdapter({...common,credentials:{apiKey:()=>key}})
      :format==='codex_responses'?createResponsesAdapter({...common,credentials:{authorization:()=>`Bearer ${key}`}})
      :format==='gemini'?createGeminiAdapter({...common,credentials:{apiKey:()=>key}})
      :format==='chat_completions'?createChatCompletionsAdapter({...common,credentials:{authorization:()=>key?`Bearer ${key}`:undefined}})
      :undefined;
    if(!adapter)throw Error('unknown host-eval wire format');
    const transcripts: Recording['transcripts'] = [];
    const report=await runHostEval(HOST_SCENARIOS,c,async input=>{
      const transcript: Recording['transcripts'][number]={id:input.id,calls:[]};
      transcripts.push(transcript);
      const original = new Map(input.tools.map(t=>[t.name.replaceAll('.', '_'),t.name]));
      if(original.size!==input.tools.length)throw Error('tool wire-name collision');
      const result=await adapter.complete({model:c.model,maxTokens:4096,messages:[{role:'system',content:'Select the tool calls needed for this task. Policy is enforced by the harness; do not invent approvals. File paths are relative to workspace. Process simulation uses program fixture-process, cwd workspace, args ["json"].'},{role:'user',content:input.prompt}],tools:input.tools.map(t=>({name:t.name.replaceAll('.', '_'),description:t.description,parameters:t.inputSchema as JsonObject}))});
      const calls=result.toolCalls.map(call=>({name:original.get(call.name) ?? call.name,args:JSON.parse(call.argumentsRaw) as unknown}));
      transcript.calls=calls;
      return calls;
    },hostHarness,'live');
    reports.push(report);
    captured.push({provider:c.provider,model:c.model,wireFormat:format,suite:HOST_EVAL_SUITE,recordedAt:report.generatedAt,transcripts});
  }
}
// The 7-day freshness rule is release qualification only (--require-release, the v* tag gate); see shippedReleaseGate.
const gate=shippedReleaseGate(defaults,advisory,reports,requireRelease);
if(process.argv.includes('--recorded')||requireRelease)for(const m of gate.advisoryWarnings)console.warn(`warning: advisory shipped model ${m} has no supported recording; not blocking until the owner confirms it`);
if(live && reports.some(r=>r.status==='completed' && (r.successRate<.95 || r.policyEscapes!==0)))process.exitCode=1;
if(live)await writeFile(join(output,'host-eval-recordings.json'),JSON.stringify({schema:'plur1bus.host-eval-recordings/1',models:captured},null,2)+'\n');
await writeFile(join(output,'host-reports.json'),JSON.stringify(reports,null,2)+'\n');
await writeFile(join(output,'gate.json'),JSON.stringify({suite:HOST_EVAL_SUITE,mode:live?'live':process.argv.includes('--recorded')?'recorded':'fixture',...gate,reason:defaults.length?undefined:'No shipped/default model inventory supplied; fixture success is not model qualification.'},null,2)+'\n');
for(const r of reports) await writeFile(join(output,Buffer.from(JSON.stringify([r.provider,r.model])).toString('base64url')+'.json'),JSON.stringify(r,null,2)+'\n');
console.log(JSON.stringify({mode:live?'live':process.argv.includes('--recorded')?'recorded':'fixture',models:reports.length,scenarios:reports.map(r=>({status:r.status,total:r.scenarios.length,rate:r.successRate})),releaseGate:gate.passed}));
if(requireRelease&&!gate.passed)process.exitCode=1;
