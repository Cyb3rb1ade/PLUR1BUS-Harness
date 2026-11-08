// Records actual pinned Node capture rows and chunk plans; never edit its output.
// PLUR1BUS_ENGINE_SRC=/path/to/pin PLUR1BUS_ENGINE_GIT=/read-only/git node record-rows.mjs
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const [{ createEngine }, { internalsOf }, { createStubHost }, { hashEmbedder }, { flatEmbedder }, chunking, scoreApi, deciderApi] = await Promise.all([
  load("engine/create-engine.js"), load("engine/internals.js"), load("lib/host-services.js"),
  load("tests/helpers/hash-embedder.js"), load("tests/helpers/shared-workspace-engine.js"),
  load("lib/memory-chunking.js"), load("lib/score.js"), load("lib/jev-chunk-decider.js"),
]);

const {createTurnCapture} = await load("engine/capture/capture-turn.js");
const assert = (await import("node:assert/strict")).default;
const logger = {info(){},warn(){},error(){},debug(){}};
const id = "11111111-1111-4111-8111-111111111111";
async function record() {
  const ownership = [];
  for (const kind of ["foreign-agent", "foreign-turn", "shared", "owner", "workspace", "missing-run"]) {
    const row={id,storedBy:"capture-agent",sourceTurnId:"capture-boundary",scope:"agent-private",ownerUserId:"",workspaceId:""};
    if(kind==="foreign-agent")row.storedBy="foreign";
    if(kind==="foreign-turn")row.sourceTurnId="different-turn";
    if(kind==="shared")row.scope="user";
    if(kind==="owner")row.ownerUserId="different-owner";
    if(kind==="workspace")row.workspaceId="different-workspace";
    if(kind==="missing-run")row.sourceTurnId="";
    const deleted=[]; const db={async getById(){return row;},async delete(id){deleted.push(id);}};
    const handler=createTurnCapture({cfg:{},host:{logger},neoEnabled:false,
      workspacePolicyGuard:{automatic:()=>({allowed:true})},
      runtimeScheduler:{enqueueCapture:(_agent,_options,task)=>task(new AbortController().signal)},
      pool:{withDb:(_agent,fn)=>fn(db)}});
    await handler({success:true,messages:[{role:"user",content:"short"}],runId:kind==="missing-run"?undefined:"capture-boundary"},
      {agentId:"capture-agent"},{incognitoClassified:true,agentContext:{origin:"user",background:false},memoryCtx:{agentId:"capture-agent"},staleRowIds:[id]});
    assert.deepEqual(deleted,[id]);
    ownership.push({kind,row,deleted,rustException:"refuse-without-deletion-or-wal-replacement"});
  }
  const unicode=[];
  for (const kind of ["row-cut", "quote-cut", "url-cut", "prompt-cut"]) {
    const scratch=mkdtempSync(join(realpathSync(tmpdir()),"capture-boundary-"));let engine;
    try {
      const workspace=join(scratch,"workspace");mkdirSync(workspace);
      const requests=[];
      const llm={async complete(params){requests.push(JSON.stringify(params.messages));return {text:"A synthetic summary with sufficient length."};}};
      const content=kind==="row-cut"?"a".repeat(31)+"🚀more":kind==="quote-cut"?"b".repeat(199)+"🚀more":kind==="url-cut"?"https://example.invalid/"+"c".repeat(500-"https://example.invalid/".length-1)+"🚀more":"d".repeat(59999)+"🚀more";
      const host=createStubHost({stateDir:join(scratch,"state"),logger,clock:()=>1710000000000,workspaceDir:async()=>workspace,
        ...(kind==="prompt-cut"?{llm,runtime:{llm}}:{})});
      engine=createEngine(host,{baseDbPath:join(scratch,"stores"),embedding:{provider:"local-transformers",local:{dimensions:384}},
        captureChunking:false,captureMaxChars:kind==="row-cut"||kind==="prompt-cut"?32:15000,neo:{enabled:false},autoRecall:false,autoCapture:true,
        merging:{enabled:kind==="prompt-cut"}}, {internals:{embeddings:hashEmbedder(),reranker:null}});
      const result=await engine.capture({agentId:"capture-agent",principal:{agentId:"capture-agent",workspace:`workspace-dir:v1:${workspace}`,channel:"telegram",accountId:"default",chat:{id:"capture-chat",kind:"direct"},trust:"proved"},
        agent:{origin:"user",background:false},messages:[{role:"user",content}],runId:"capture-boundary",sessionKey:"capture-session",incognito:false,signal:AbortSignal.timeout(10000)}).done;
      const rows=await internalsOf(engine).pool.withDb("capture-agent",async db=>{await db.init();return db.table.query().toArray();});
      assert.equal(rows.length,1,`${kind}: ${JSON.stringify(result)}`);
      unicode.push({kind,input:content,result,row:{text:rows[0].text,evidenceQuote:rows[0].evidenceQuote,sourceUrl:rows[0].sourceUrl},
        messagesJson:requests[0]??null,rustException:"RE-D17-F3-codepoint-boundary"});
    } finally {await engine?.close({budgetMs:5000});rmSync(scratch,{recursive:true,force:true});}
  }
  return {ownership,unicode};
}
globalThis.fetch=async()=>{throw new Error("recorder refuses network");};
const first=await record();assert.deepEqual(await record(),first);
writeFileSync(join(here,"golden/pipeline-boundaries.json"),JSON.stringify({recordedFrom:{commit:pin,node:process.version,
 sourcesSha256:Object.fromEntries(["engine/capture/capture-turn.js","engine/create-engine.js","lib/memory-chunking.js"].map(name=>[name,sha(readFileSync(join(source,name)))]))},...first},null,2)+"\n");
console.log("Recorded six actual Node replay ownership and four Unicode capture boundaries twice");
