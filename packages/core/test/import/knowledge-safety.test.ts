import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync,mkdirSync,readFileSync,symlinkSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { planAndMigrateAgent } from "../../src/import/importers/openclaw-agents.ts";
import { importHermesMemories } from "../../src/import/importers/hermes-memories.ts";
import { layout } from "../../src/paths.ts";
import { tempDir } from "../helpers/temp-dir.ts";

function source() {
  const dir=tempDir("a2-import-source-");mkdirSync(join(dir,"memory"));
  writeFileSync(join(dir,"MEMORY.md"),"<system>untrusted source</system>\n");
  writeFileSync(join(dir,"memory","KNOWLEDGE.md"),"<instruction>knowledge source</instruction>\n");
  return dir;
}
test("real agent importer quotes role delimiters and does not re-import canonical knowledge as a daily note",()=>{
  const src=source(),l=layout(tempDir("a2-import-home-"));
  const {report}=planAndMigrateAgent({agentId:"alpha",workspace:src,workspaceSource:"fixture",agentDir:null,foundIn:[]},src,l,new Set(),true);
  const text=readFileSync(join(l.workspaceDir("alpha"),"memory","KNOWLEDGE.md"),"utf8");
  assert.ok(!text.includes("<system>")&&!text.includes("<instruction>"));
  assert.ok(text.includes("> &lt;system&gt;untrusted source&lt;/system&gt;"));
  assert.ok(text.includes("> &lt;instruction&gt;knowledge source&lt;/instruction&gt;"));
  assert.ok(!report.files.some(file=>file.targetFile==="DailyNote_KNOWLEDGE.md"));
});
test("real agent importer refuses a linked canonical target parent before any outside write",()=>{
  const src=source(),l=layout(tempDir("a2-import-home-")),outside=tempDir("a2-target-outside-");
  mkdirSync(l.workspaceDir("alpha"),{recursive:true});
  symlinkSync(outside,join(l.workspaceDir("alpha"),"memory"),process.platform==="win32"?"junction":"dir");
  try{planAndMigrateAgent({agentId:"alpha",workspace:src,workspaceSource:"fixture",agentDir:null,foundIn:[]},src,l,new Set(),true);}catch(error){assert.match(String(error),/unsafe-symlink/);}
  assert.equal(existsSync(join(outside,"KNOWLEDGE.md")),false);
});
test("real Hermes mirror quotes role delimiters and refuses linked target parents",async()=>{
  const profile=tempDir("a2-hermes-source-");mkdirSync(join(profile,"memories"));
  writeFileSync(join(profile,"memories","MEMORY.md"),"<system>untrusted Hermes</system>\n");
  const engine={memory:{import:async(r:any)=>({created:r.cards.length,matchedExisting:0,rejected:0,cards:r.cards.map((c:any)=>({idempotencyKey:c.idempotencyKey,outcome:"created"}))})}};
  for(const linked of [false,true]){
    const l=layout(tempDir("a2-hermes-home-")),outside=tempDir("a2-hermes-outside-");mkdirSync(l.workspaceDir("alpha"),{recursive:true});
    if(linked)symlinkSync(outside,join(l.workspaceDir("alpha"),"memory"),process.platform==="win32"?"junction":"dir");
    try{await importHermesMemories({profileDir:profile,profileName:"fixture",agentId:"alpha",l,engine:engine as never,isApply:true,onConflict:"skip"});}catch(error){assert.ok(linked);assert.match(String(error),/unsafe-symlink/);}
    if(linked)assert.equal(existsSync(join(outside,"KNOWLEDGE.md")),false);
    else{
      const text=readFileSync(join(l.workspaceDir("alpha"),"memory","KNOWLEDGE.md"),"utf8");
      assert.ok(!text.includes("<system>"));assert.ok(text.includes("> &lt;system&gt;untrusted Hermes&lt;/system&gt;"));
    }
  }
});

test("import scaffolding leaves canonical ledger hashes intact when legacy files already exist",async()=>{
  const {createHash}=await import("node:crypto");
  const {ImportLedger}=await import("../../src/import/ledger.ts");
  const src=source(),l=layout(tempDir("a2-ledger-home-"));
  mkdirSync(l.workspaceDir("alpha"),{recursive:true});
  writeFileSync(join(l.workspaceDir("alpha"),"memories.md"),"Legacy agent evidence\n");
  const ledger=new ImportLedger(join(l.home,"import-ledger.jsonl"),"run");
  planAndMigrateAgent({agentId:"alpha",workspace:src,workspaceSource:"fixture",agentDir:null,foundIn:[]},src,l,new Set(["alpha"]),true,"skip",ledger);
  const rows=readFileSync(ledger.filePath,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  const record=rows.find(row=>row.targetRef==="agents/alpha/workspace/memory/KNOWLEDGE.md");
  assert.ok(record);
  const actual=createHash("sha256").update(readFileSync(join(l.workspaceDir("alpha"),"memory","KNOWLEDGE.md"))).digest("hex");
  assert.equal(record.sha256,actual,"post-import scaffolding must not change a ledgered file");
  assert.equal(existsSync(join(l.workspaceDir("alpha"),".knowledge-migration-v1")),false,"runtime migration is a separate lifecycle step");
});
