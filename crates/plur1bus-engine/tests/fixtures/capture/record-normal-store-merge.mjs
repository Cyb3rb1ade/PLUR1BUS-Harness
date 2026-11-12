// Records actual pinned Node normal-store merge preparation and execution; never edit its output.
// PLUR1BUS_ENGINE_SRC=/path/to/pin PLUR1BUS_ENGINE_GIT=/read-only/git node record-normal-store-merge.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const sourceGit = process.env.PLUR1BUS_ENGINE_GIT;
if (!source || !sourceGit) throw new Error("pinned source and read-only Git source are required");
if (process.version !== "v24.21.0") throw new Error("capture recorder requires Node 24.21.0");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", ["-C", sourceGit, ...args], { maxBuffer: 16 * 1024 * 1024 });
const legacyMarker = ["open", "claw"].join("");
const paths = git("ls-tree", "-r", "--name-only", pin, "engine", "lib", "tests/helpers", "package.json", `${legacyMarker}.plugin.json`)
  .toString().trim().split("\n").filter((name) => /\.(?:js|json)$/.test(name));
const hashes = [];
for (const name of paths) {
  const expected = sha(git("show", `${pin}:${name}`));
  const actual = sha(readFileSync(join(source, name)));
  if (actual !== expected) throw new Error("pinned source hash mismatch");
  hashes.push({ pathParts: name.split(legacyMarker), sha256: actual });
}

// Dependencies resolve from this prepared Harness checkout; Node source still comes from the verified pin.
const require = createRequire(resolve(here, "../../../../../packages/core/package.json"));
const engineRequire = createRequire(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const dependencies = new Map(["@lancedb/lancedb", "apache-arrow", "openai", "@huggingface/transformers"]
  .map((name) => [name, pathToFileURL(engineRequire.resolve(name)).href]));
registerHooks({
  resolve(specifier, context, nextResolve) {
    return dependencies.has(specifier)
      ? { url: dependencies.get(specifier), shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const load = (name) => import(pathToFileURL(join(source, name)).href);
// Verify the test helper before importing it, as for every engine source above.
const helper = "tests/helpers/hash-embedder.js";
const helperExpected = sha(git("show", `${pin}:${helper}`));
if (sha(readFileSync(join(source, helper))) !== helperExpected) throw new Error("pinned helper hash mismatch");
hashes.push({ pathParts: [helper], sha256: helperExpected });
const [{ createEngine }, { internalsOf }, { createStubHost }, { hashEmbedder }] = await Promise.all([
  load("engine/create-engine.js"), load("engine/internals.js"), load("lib/host-services.js"),
  load("tests/helpers/hash-embedder.js"),
]);
const assert = (await import("node:assert/strict")).default;
const {MEMORY_ORIGINS,categorizeMemoryWithReason}=await load("lib/categorize.js");
const {computeMemoryImportance}=await load("lib/memory-fact-quality.js");
const {normalizeCapturedValidityWindow}=await load("lib/valid-time.js");
const NOW=1735689600000,ID="11111111-1111-4111-8111-111111111111",OWNER=`user:v1:${sha("synthetic normal store owner")}`,WORKSPACE="workspace:v1:fixture";
const baseText="I enjoy drinking coffee every morning.",incoming="I enjoy coffee every morning.",merged="I enjoy drinking coffee every morning and find this routine pleasant.";
const base={text:incoming,category:"fact"};
const scenarios=[
 {name:"basic"},{name:"explicit-importance",params:{importance:0.8}},{name:"existing-importance",original:{importance:0.9}},{name:"core-with-ttl",params:{importance:0.97,ttl:"session"}},{name:"existing-core",original:{importance:0.97}},
 {name:"session-ttl",params:{ttl:"session"}},{name:"short-ttl",params:{ttl:"short"}},{name:"unknown-ttl",params:{ttl:"unknown"}},
 {name:"category-auto",params:{category:null}},{name:"decision",params:{category:"decision"}},{name:"voice",params:{origin:"voice"}},{name:"invalid-origin",params:{origin:"invalid"}},
 {name:"provenance-cuts",params:{sourceUrl:"u".repeat(499)+"😀tail",evidenceQuote:"e".repeat(199)+"🪟tail"}},
 {name:"validity-union",original:{validFrom:17,validUntil:99},params:{validFrom:23,validUntil:111}},
 {name:"validity-open",original:{validFrom:17,validUntil:99},params:{validFrom:23}},
 {name:"validity-disjoint",original:{validFrom:17,validUntil:99},params:{validFrom:100,validUntil:200},expected:"stored"},
 {name:"disputed",original:{epistemicStatus:"disputed"}},{name:"invalidated",original:{epistemicStatus:"invalidated"}},
 {name:"summary-limit",config:{summaryMaxWords:5}},
 {name:"half-life",config:{recall:{halfLifeDaysMap:{episodic:77}},memoryDynamics:{flashbulbEncoding:true}}},
 {name:"meaningful-difference",original:{text:"The release uses version 2."},params:{text:"The release uses version 3."},expected:"stored"},
 {name:"loses-facts",answer:{merge:true,reason:"fixture",mergedText:"This is a completely unrelated fabricated synthetic description."},expected:"stored"},
 {name:"declined",answer:{merge:false,reason:"fixture"},expected:"stored"},
 {name:"too-short",answer:{merge:true,reason:"fixture",mergedText:"coffee"},expected:"stored"},
 {name:"invalid-answer",answer:{merge:true,mergedText:merged},expected:"stored"},
 {name:"provider-failure",reject:true,expected:"stored"},
 {name:"auto-apply-off",config:{merging:{autoApply:false}},expected:"stored"},
];
const RealDate=Date,previousFetch=globalThis.fetch;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}};globalThis.fetch=async()=>{throw new Error("unrecorded network refused");};
const clone=value=>JSON.parse(JSON.stringify(value));
async function record(){const cases=[];
 for(const scenario of scenarios){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"normal-store-merge-")));const workspace=join(root,"workspace");mkdirSync(workspace);let engine;
  try{
   const calls=[],stored=[],embeddings=[];
   const llm={async complete(params){const{signal,...contract}=params;calls.push({contract,signal:signal instanceof AbortSignal});if(scenario.reject)throw new Error("synthetic route failure");return {text:JSON.stringify(scenario.answer??{merge:true,reason:"fixture",mergedText:merged})};}};
   const host=createStubHost({stateDir:join(root,"state"),workspaceDir:async()=>workspace,pathOverrides:{[`${legacyMarker}Home`]:()=>root,stateDirOverride:()=>join(root,"state"),configPathOverride:()=>join(root,"state/config.json")},clock:()=>NOW,logger:{info(){},warn(){},error(){},debug(){}},llm,runtime:{llm}});
   const config={baseDbPath:join(root,"stores"),embedding:{provider:"local-transformers",local:{dimensions:384}},autoCapture:false,autoRecall:false,neo:{enabled:false},gc:{enabled:false},obsidianBridge:{enabled:false},metaCognition:{enabled:false},runtime:{llmResultCacheEnabled:false,llmResultCachePersist:false},...scenario.config,merging:{enabled:true,autoApply:true,...scenario.config?.merging}};
   const embed=hashEmbedder();const originalEmbed=embed.embed.bind(embed);embed.embed=async(text,options)=>{embeddings.push(text);return originalEmbed(text,options);};
   engine=createEngine(host,config,{internals:{embeddings:embed,reranker:null}});const internal=internalsOf(engine);
   const{resolveDefaultArchiveDir}=await load("lib/telegram-commands/memory-edit.js");assert.equal(resolveDefaultArchiveDir(),join(root,`.${legacyMarker}`,"memory","_archive"));
   const original={id:ID,text:baseText,summary:"",agentId:"alpha",storedBy:"alpha",workspaceId:WORKSPACE,workspaceKey:WORKSPACE,scope:"agent-private",ownerUserId:OWNER,status:"active",vector:[1,0,0,0],importance:0.5,category:"fact",validFrom:0,validUntil:0,epistemicStatus:"trusted",previousEpistemicStatus:"observed",epistemicStatusActor:"fixture",epistemicStatusReason:"fixture",epistemicStatusUpdatedAt:NOW-1,...scenario.original};
   const rows=new Map([[ID,clone(original)]]);
   const db={findSimilar:async()=>[],findMergeCandidate:async()=>({entry:clone(original),score:0.8}),getById:async id=>clone(rows.get(id)??null),store:async row=>{stored.push(clone(row));rows.set(row.id,clone(row));return row;},delete:async id=>{assert(existsSync(join(root,`.${legacyMarker}`,"memory","_archive","alpha")));rows.delete(id);return true;}};
   internal.pool.withWriteDb=async(agent,fn)=>{assert.equal(agent,"alpha");return fn(db);};
   const params={...base,...scenario.params};const memoryCtx={agentId:"alpha",userPrincipal:OWNER,workspaceIdentity:WORKSPACE,workspaceId:WORKSPACE,workspaceDir:workspace,workspaceAliases:{paths:[],aliases:[]},sessionKey:"fixture"};
   const result=await internal.storeMemoryFromToolParams({memoryCtx,workspaceDir:workspace,callContext:{runtimeLlm:llm,signal:AbortSignal.timeout(15000)}},params);
   assert.equal(result.details?.action,scenario.expected??"merged",`${scenario.name}: ${JSON.stringify(result)}`);
   assert.equal(stored.length,1);assert.equal(calls.length,scenario.name==="auto-apply-off"||scenario.name==="meaningful-difference"?0:1);
   if(result.details.action==="merged"){assert.equal(embeddings.length,2);assert(!rows.has(ID));}else assert(rows.has(ID));
   const archiveDir=join(root,`.${legacyMarker}`,"memory","_archive","alpha");const archive=existsSync(archiveDir)?readdirSync(archiveDir).map(name=>({name,value:JSON.parse(readFileSync(join(archiveDir,name),"utf8"))})):[];
   const auditPath=join(workspace,".adaptive-learning/destructive-ops.jsonl");const audit=existsSync(auditPath)?readFileSync(auditPath,"utf8").trim().split("\n").map(line=>JSON.parse(line)):[];
   const category=params.category?{category:params.category,reason:"caller-provided"}:categorizeMemoryWithReason(params.text);
   const origin=MEMORY_ORIGINS.includes(params.origin)?params.origin:"dm";
   const importance=computeMemoryImportance({text:params.text,category:category.category,categoryReason:category.reason,explicitImportance:params.importance,origin});
   const validity=normalizeCapturedValidityWindow(params,{logger:host.logger});
   const scope=internal.resolveStoreScopeAccess(memoryCtx,params.scope);
   const writeKey=internal.durableMergeWriteKey({workspaceKey:scope.ownershipFields.workspaceKey,text:params.text,category:category.category,origin,importance:importance.importance,ttl:["session","short"].includes(params.ttl)?params.ttl:"",sourceUrl:stored[0].sourceUrl,evidenceQuote:stored[0].evidenceQuote,scope:scope.scope,ownerUserId:scope.ownerUserId,validFrom:validity.validFrom,validUntil:validity.validUntil});
   if(result.details.action==="merged"){
    let checkedId;await internal.withDurableMerge({db:{getById:async()=>clone(original)},agentId:"alpha",selectedCandidate:{entry:clone(original),score:0.8},accessCtx:memoryCtx,workspaceDir:workspace,writeKey,prepareReplacement:async(_row,id)=>{checkedId=id;return null;}});assert.equal(checkedId,result.details.id);
   }
   const item={scenario,params,original,assessment:{category,origin,importance,validity,writeKey},stored,modelCalls:calls,embeddings,action:result.details.action,id:result.details.id,archive,audit};
   let text=JSON.stringify(item).replaceAll(join(root,`.${legacyMarker}`),"<archive-root>");if(result.details.action==="stored")text=text.replaceAll(result.details.id,"__NEW_UUID__");
   cases.push(JSON.parse(text));
  }finally{await engine?.close({budgetMs:5000});rmSync(root,{recursive:true,force:true});}
 }return cases;
}
try{const cases=await record();assert.deepEqual(await record(),cases);const output=JSON.stringify({pin,now:NOW,node:process.version,sourceHashes:hashes,sourcePathJoiner:["open","claw"],boundaries:{database:"offline map port; actual normal-store function",embedding:"pinned offline hash embedding",model:"synthetic host callback",archive:"real temporary files; host root asserted before invocation",normalization:"temporary archive root and separately-stored random UUID only; derived merge IDs unchanged"},cases},null,2)+"\n";writeFileSync(join(here,"golden/normal-store-merge.json"),output);console.log(`Recorded ${cases.length} actual normal-store preparations twice; SHA-256 ${sha(output)}`);}finally{globalThis.Date=RealDate;globalThis.fetch=previousFetch;}
