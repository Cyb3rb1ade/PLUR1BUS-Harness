#!/usr/bin/env node
// Explicit offline spike; runtime dependencies are supplied by an existing installation.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { cpus, platform, arch, release, totalmem, freemem } from 'node:os';
import { artifactPath } from './decision-laya-paths.mjs';
import { softmax, temperatureFor, buildInputs, evaluate, germanGate, percentile, validateCases, summarizeLatencyPhases } from './decision-laya-lib.mjs';

export async function verifyArtifacts(directory,manifest) {
  for(const file of manifest.files){
    if(!/^[a-zA-Z0-9_./-]+$/.test(file.file)||file.file.split('/').includes('..')||!Number.isSafeInteger(file.size)||file.size<1||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('invalid manifest');
    const path=await artifactPath(directory,file.file),info=await stat(path);
    if(info.size!==file.size)throw Error(`artifact size: ${file.file}`);
    const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
    if(hash.digest('hex')!==file.sha256)throw Error(`artifact digest: ${file.file}`);
  }
}
export async function loadLaya({directory,runtimePackage,manifest,threads=1}) {
  await verifyArtifacts(directory,manifest);
  const require=createRequire(resolve(runtimePackage));
  const ort=await import(pathToFileURL(require.resolve('onnxruntime-node')).href);
  const {PreTrainedTokenizer,env}=await import(pathToFileURL(require.resolve('@huggingface/transformers')).href);
  env.allowRemoteModels=false;
  const json=async file=>JSON.parse(await readFile(join(directory,file),'utf8'));
  const tokenizer=new PreTrainedTokenizer(await json('tokenizer/tokenizer.json'),await json('tokenizer/tokenizer_config.json'));
  const raw=tokenizer._tokenizer;
  const tok={encode:text=>tokenizer.encode(text,{add_special_tokens:false}),cls:raw.token_to_id('[CLS]'),sep:raw.token_to_id('[SEP]'),mask:raw.token_to_id('[MASK]')};
  const config=await json('rl_agent_config.json');
  const session=await ort.InferenceSession.create(join(directory,'model.onnx'),{executionProviders:['cpu'],intraOpNumThreads:threads,interOpNumThreads:1});
  const tensor=(type,data,dims)=>new ort.Tensor(type,data,dims);
  return {
    async run(requests){
      const inputs=requests.map(req=>buildInputs(req,tok,config));
      const n=inputs.length,seq=Math.max(...inputs.map(r=>r.ids.length)),options=Math.max(...inputs.map(r=>r.positions.length));
      const ids=new BigInt64Array(n*seq),mask=new BigInt64Array(n*seq),positions=new BigInt64Array(n*options),markerMask=new Uint8Array(n*options),types=new BigInt64Array(n);
      for(let i=0;i<n;i++){
        inputs[i].ids.forEach((v,j)=>{ids[i*seq+j]=BigInt(v);mask[i*seq+j]=1n;});
        inputs[i].positions.forEach((v,j)=>{positions[i*options+j]=BigInt(v);markerMask[i*options+j]=1;});
        types[i]=BigInt({choice:0,score:1,noul:2}[requests[i].primitive]);
      }
      const output=await session.run({input_ids:tensor('int64',ids,[n,seq]),attention_mask:tensor('int64',mask,[n,seq]),marker_pos:tensor('int64',positions,[n,options]),marker_mask:tensor('bool',markerMask,[n,options]),qtype:tensor('int64',types,[n])});
      return requests.map((req,i)=>{
        const count=req.options.length,logits=Array.from(output.logits.data.slice(i*options,i*options+count));
        const p=softmax(logits,temperatureFor(config,req.primitive,count));
        // Entropy confidence is a derived diagnostic, not a new fitted calibration.
        const confidence=1+p.reduce((s,v)=>s+(v===0?0:v*Math.log(v)),0)/Math.log(count);
        return {probabilities:Object.fromEntries(req.options.map((o,j)=>[o.id,p[j]])),confidence,confidenceSource:'derived'};
      });
    },
    async close(){await session.release();},
  };
}
async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||!args[i+1])throw Error('usage: --model-dir PATH --runtime-package package.json --out PATH [--threads N]');options[args[i].slice(2)]=args[i+1];}
  if(!options['model-dir']||!options['runtime-package']||!options.out)throw Error('model-dir, runtime-package and out required');
  const manifest=JSON.parse(await readFile(new URL('./decision-laya-manifest.json',import.meta.url),'utf8'));
  const fixture=JSON.parse(await readFile(new URL('./decision-eval-cases.json',import.meta.url),'utf8'));
  validateCases(fixture.cases);
  const threads=Number(options.threads??1);if(!Number.isSafeInteger(threads)||threads<1||threads>16)throw Error('invalid threads');
  const freeMemoryBeforeBytes=freemem();
  const started=performance.now();const model=await loadLaya({directory:options['model-dir'],runtimePackage:options['runtime-package'],manifest,threads});
  const loadMs=performance.now()-started,rows=[],latencies=[];
  try{
    for(const row of fixture.cases)for(const locale of ['de','en']){
      const request={primitive:row.primitive,question:row.question[locale],state:row.state[locale],options:row.options.map(o=>({id:o.id,description:o.description[locale]}))};
      const before=performance.now();
      try{const [answer]=await model.run([request]);const elapsedMs=performance.now()-before;latencies.push(elapsedMs);rows.push({id:row.id,useCase:row.useCase,coreGate:row.coreGate,locale,gold:row.gold,...answer,elapsedMs});}
      catch{rows.push({id:row.id,useCase:row.useCase,coreGate:row.coreGate,locale,gold:row.gold,error:'inference-failed'});}
    }
    const core=locale=>rows.filter(r=>r.coreGate&&r.locale===locale);
    const complete=['de','en'].every(l=>core(l).length===60&&core(l).every(r=>!r.error));
    const de=complete?evaluate(core('de')):null,en=complete?evaluate(core('en')):null;
    const perUseCase={};for(const useCase of new Set(rows.map(r=>r.useCase)))for(const locale of ['de','en']){const selected=rows.filter(r=>r.useCase===useCase&&r.locale===locale);perUseCase[`${useCase}:${locale}`]=selected.every(r=>!r.error)?evaluate(selected):{n:selected.length,errors:selected.filter(r=>r.error).length};}
    const five=fixture.cases.slice(0,5).map(row=>({primitive:row.primitive,question:row.question.en,state:row.state.en,options:row.options.map(o=>({id:o.id,description:o.description.en}))}));
    const fiveMs=[];for(let i=0;i<10;i++){const before=performance.now();await model.run(five);fiveMs.push(performance.now()-before);}
    const gate=germanGate({de,en,paired:complete?60:0,verified:true});
    const report={schema:'plur1bus.decision-spike/1',at:new Date().toISOString(),node:process.version,platform:platform(),arch:arch(),os:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),freeMemoryBeforeBytes,freeMemoryAfterBytes:freemem(),fileCacheState:'uncontrolled',threads,manifest,fixtureSha256:createHash('sha256').update(await readFile(new URL('./decision-eval-cases.json',import.meta.url))).digest('hex'),labelSource:fixture.labelSource,loadMs,...summarizeLatencyPhases(latencies),latency:{n:latencies.length,p50:percentile(latencies,.5),p95:percentile(latencies,.95)},fiveQuestionBatch:{n:10,p50:percentile(fiveMs,.5),p95:percentile(fiveMs,.95)},maxRssKiB:process.resourceUsage().maxRSS,germanGate:gate,automaticGermanEligibility:false,eligibilityReason:'Requires independent label validation, role comparison and native Linux/Windows evidence',perUseCase,rows};
    await writeFile(options.out,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({...report,rows:undefined,manifest:undefined,perUseCase:undefined},null,2));
  }finally{await model.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
