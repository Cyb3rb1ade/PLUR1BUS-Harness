import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

// Import dynamically so the initial RED identifies the missing migration API explicitly.
const load = () => import("../../src/knowledge/migration.ts" as string);
function fixture() {
  const workspace = tempDir("a2-knowledge-");
  mkdirSync(join(workspace,"memory"));
  writeFileSync(join(workspace,"memory","KNOWLEDGE.md"),"# Existing\nKeep this verbatim.\n");
  writeFileSync(join(workspace,"knowledgepool.md"),"Legacy knowledge about release gates.\n");
  writeFileSync(join(workspace,"memories.md"),"Long-term agent fact about Thursday planning.\n");
  writeFileSync(join(workspace,"USER.md"),"PRIVATE PERSON MARKER");
  return workspace;
}
test("migration combines legacy agent knowledge once, reports sources and preserves existing knowledge",async()=>{
  const { migrateLegacyKnowledge }=await load();
  const workspace=fixture();
  const report=migrateLegacyKnowledge(workspace);
  assert.equal(report.state,"applied");
  assert.deepEqual(report.sources.map((s:any)=>s.name),["knowledgepool.md","memories.md"]);
  const target=join(workspace,"memory","KNOWLEDGE.md");
  const first=readFileSync(target,"utf8");
  assert.ok(first.startsWith("# Existing\nKeep this verbatim.\n"));
  assert.ok(first.includes("Legacy knowledge about release gates."));
  assert.ok(first.includes("Long-term agent fact about Thursday planning."));
  assert.ok(!first.includes("PRIVATE PERSON MARKER"));
  assert.deepEqual(migrateLegacyKnowledge(workspace),report);
  assert.equal(readFileSync(target,"utf8"),first);
});
test("rollback restores the previous canonical bytes and never overwrites a later Engine write",async()=>{
  const { migrateLegacyKnowledge,rollbackKnowledgeMigration }=await load();
  const workspace=fixture();
  migrateLegacyKnowledge(workspace);
  const target=join(workspace,"memory","KNOWLEDGE.md");
  const migrated=readFileSync(target,"utf8");
  writeFileSync(target,migrated+"\nLater Engine entry.\n");
  assert.throws(()=>rollbackKnowledgeMigration(workspace),/knowledge-changed/);
  assert.ok(readFileSync(target,"utf8").endsWith("Later Engine entry.\n"));
  writeFileSync(target,migrated);
  assert.equal(rollbackKnowledgeMigration(workspace).state,"rolled-back");
  assert.equal(readFileSync(target,"utf8"),"# Existing\nKeep this verbatim.\n");
  assert.equal(rollbackKnowledgeMigration(workspace).state,"rolled-back");
  assert.equal(migrateLegacyKnowledge(workspace).state,"rolled-back","startup cannot undo an explicit rollback");
});
test("rollback removes a canonical file created by the migration, retaining all legacy sources",async()=>{
  const { migrateLegacyKnowledge,rollbackKnowledgeMigration }=await load();
  const workspace=tempDir("a2-new-knowledge-");
  writeFileSync(join(workspace,"memories.md"),"Original fact\n");
  migrateLegacyKnowledge(workspace);
  rollbackKnowledgeMigration(workspace);
  assert.equal(existsSync(join(workspace,"memory","KNOWLEDGE.md")),false);
  assert.equal(readFileSync(join(workspace,"memories.md"),"utf8"),"Original fact\n");
});
test("linked sources, target directories and migration state are refused without writes",async()=>{
  const { migrateLegacyKnowledge }=await load();
  for(const name of ["memories.md","memory",".knowledge-migration-v1"]){
    const workspace=tempDir("a2-links-");
    const outside=tempDir("a2-outside-");
    writeFileSync(join(outside,"fact.md"),"do not read");
    if(name==="memories.md"){
      symlinkSync(join(outside,"fact.md"),join(workspace,name));
    }else symlinkSync(outside,join(workspace,name),process.platform==="win32"?"junction":"dir");
    assert.throws(()=>migrateLegacyKnowledge(workspace),/unsafe-symlink/);
    assert.equal(readFileSync(join(outside,"fact.md"),"utf8"),"do not read");
    assert.deepEqual(readdirSync(outside),["fact.md"]);
  }
});

test("prepared migration resumes after a crash and rollback resumes after target restoration",async()=>{
  const { migrateLegacyKnowledge,rollbackKnowledgeMigration }=await load();
  const workspace=fixture();
  const report=migrateLegacyKnowledge(workspace);
  const reportPath=join(workspace,".knowledge-migration-v1","report.json");
  writeFileSync(reportPath,JSON.stringify({...report,state:"prepared"}));
  writeFileSync(join(workspace,"memory","KNOWLEDGE.md"),"# Existing\nKeep this verbatim.\n");
  assert.equal(migrateLegacyKnowledge(workspace).state,"applied");
  // Model a crash after restoring target bytes but before committing the rollback report.
  writeFileSync(join(workspace,"memory","KNOWLEDGE.md"),"# Existing\nKeep this verbatim.\n");
  assert.equal(rollbackKnowledgeMigration(workspace).state,"rolled-back");
});
test("migration preserves an existing UTF-8 BOM byte for byte",async()=>{
  const { migrateLegacyKnowledge }=await load();
  const workspace=fixture();
  const before=Buffer.from("\ufeff# Original\r\nKeep exact bytes.\r\n");
  const target=join(workspace,"memory","KNOWLEDGE.md");
  writeFileSync(target,before);
  migrateLegacyKnowledge(workspace);
  assert.deepEqual(readFileSync(target).subarray(0,before.length),before);
});

test("offline repair CLI reports migration/rollback and refuses a running core",async()=>{
  const {spawnSync}=await import("node:child_process");
  const {layout}=await import("../../src/paths.ts");
  const home=tempDir("a2-repair-");
  const l=layout(home);
  const workspace=l.workspaceDir("alpha");
  mkdirSync(workspace,{recursive:true});
  writeFileSync(join(workspace,"memories.md"),"CLI legacy evidence\n");
  const cli=new URL("../../../../scripts/migrate-curated-knowledge.mjs",import.meta.url);
  const {fileURLToPath}=await import("node:url");
  const run=(extra:string[]=[])=>spawnSync(process.execPath,["--experimental-strip-types","--conditions=source",fileURLToPath(cli),"--home",home,"--agent","alpha",...extra],{encoding:"utf8"});
  const migrated=run();assert.equal(migrated.status,0,migrated.stderr);
  assert.equal(JSON.parse(migrated.stdout).report.state,"applied");
  const reverted=run(["--rollback"]);assert.equal(reverted.status,0,reverted.stderr);
  assert.equal(JSON.parse(reverted.stdout).report.state,"rolled-back");
  mkdirSync(l.run,{recursive:true});writeFileSync(l.corePid,String(process.pid));
  const refused=run();assert.notEqual(refused.status,0);assert.match(refused.stderr,/target-running/);
});

test("runtime registry scaffolding migrates legacy knowledge before an agent is used",async()=>{
  const {createAgentRegistry}=await import("../../src/agents.ts");
  const {defaults}=await import("@plur1bus/config-schema");
  const {layout}=await import("../../src/paths.ts");
  const l=layout(tempDir("a2-runtime-migration-"));
  mkdirSync(l.workspaceDir("alpha"),{recursive:true});
  writeFileSync(join(l.workspaceDir("alpha"),"knowledgepool.md"),"Runtime legacy evidence\n");
  const cfg=defaults();cfg.agents.alpha={};
  const registry=createAgentRegistry({config:()=>cfg},l);
  assert.deepEqual(registry.list(),["alpha"]);
  assert.ok(readFileSync(join(l.workspaceDir("alpha"),"memory","KNOWLEDGE.md"),"utf8").includes("Runtime legacy evidence"));
});
