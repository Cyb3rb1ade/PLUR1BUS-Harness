import assert from "node:assert/strict";
import { join } from "node:path";
import { copyFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LearnStore } from "../../packages/core/src/dreams/learn/store.ts";
import { aggregate } from "../../packages/core/src/dreams/learn/aggregation.ts";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { targetHash } from "../../packages/core/src/dreams/learn/selection.ts";

const [op, folder] = process.argv.slice(2);
assert.ok(folder);
const tsPath=join(folder,"learn-from-ts.db");
const rustPath=join(folder,"learn-from-rust.db");
const oldTsPath=join(folder,"learn-v2-to-ts.db"), oldRustPath=join(folder,"learn-v2-to-rust.db");
const target={scope:"agent" as const,owner:"fixture-owner",agentId:"fixture-agent"};
const window={from:10,to:20};
const secure=()=>({applied:true}); // A fixture-local permission double for Windows.

function schema(file:string){
  const db=new DatabaseSync(file);
  try{
    return {
      version:db.prepare("PRAGMA user_version").get(),
      integrity:db.prepare("PRAGMA integrity_check").get(),
      foreignKeys:db.prepare("PRAGMA foreign_key_check").all(),
      objects:db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name LIKE 'learn_%' ORDER BY type,name").all(),
    };
  }finally{db.close();}
}

function prepareLegacy(){
  const original=readFileSync(new URL("../../packages/core/src/dreams/learn/store.ts",import.meta.url),"utf8");
  const migrations=[...original.matchAll(/this\.#db\.exec\(`([\s\S]+?)`\)/g)].slice(0,2).map(match=>match[1]!);
  assert.equal(migrations.length,2);
  const legacy=new DatabaseSync(oldTsPath);
  try{
    migrations.forEach(sql=>legacy.exec(sql));
    const id="legacy-run", run={id,target,window,sessionIds:["legacy-session"],digest:"legacy-digest",startedAt:21,finishedAt:22,
      outcome:"completed",reason:null,tokens:0,findings:1};
    legacy.prepare("INSERT INTO learn_run(id,target_hash,window_from,window_to,metadata,owner) VALUES(?,?,?,?,?,?)")
      .run(id,targetHash(target),window.from,window.to,JSON.stringify(run),target.owner);
    const finding=aggregate([{kind:"knowledge",change:"add",text:"Legacy content",contentKey:" ＬＥＧＡＣＹ content ",evidence:[
      {sessionId:"legacy-session",turnId:"turn",sourceId:"message",source:"message",trust:"person",day:"1970-01-01",
        agentId:target.agentId,owner:deriveUserPrincipal(target.owner)}
    ]}],target,id,1)[0]!;
    legacy.prepare("INSERT INTO learn_finding VALUES(?,?,'accepted')").run(finding.id,id);
    legacy.prepare("INSERT INTO learn_payload VALUES(?,?,?)").run(id,"finding:"+finding.id,JSON.stringify(finding));
    legacy.prepare("INSERT INTO learn_decision VALUES(?,?,'accepted',?,?)")
      .run(finding.id,target.owner,23,JSON.stringify({operation:"memory.importText.apply",runId:"import"}));
  }finally{legacy.close();}
  copyFileSync(oldTsPath,oldRustPath);
}

if(op==="prepare"){
  prepareLegacy();
  const ts=new LearnStore(tsPath,secure);
  try{
    const run=ts.begin(target,window,25);
    run.sessionIds=["fixture"];run.digest="evidence-digest";ts.save(run);
    ts.checkpoint(run.id,"extract:fixture",{text:"[]",model:"fixture"});
    console.log(run.id);
  }finally{ts.close();}
}else if(op==="verify"){
  const ts=new LearnStore(tsPath,secure),rust=new LearnStore(rustPath,secure);
  try{
    const receivedTs=ts.begin(target,window,100);
    assert.equal(receivedTs.outcome,"completed");
    assert.equal(ts.payload(receivedTs.id,"extract:fixture"),null);
    const receivedRust=rust.begin(target,window,100);
    assert.equal(receivedRust.id,receivedTs.id);
    assert.equal(receivedRust.startedAt,26);
    assert.equal(receivedRust.tokens,8);
    assert.equal(rust.payload(receivedRust.id,"extract:fixture"),null);
    assert.equal(receivedRust.outcome,"failed");
    assert.equal(receivedRust.reason,"invalid-output");
  }finally{ts.close();rust.close();}
  assert.deepEqual(schema(tsPath),schema(rustPath));
  assert.equal(schema(rustPath).integrity?.integrity_check,"ok");
  assert.equal(schema(rustPath).version?.user_version,7);
  {
    const migratedTs=new LearnStore(oldTsPath,secure);
    const migratedRust=new LearnStore(oldRustPath,secure);
    try{
      const [oldFinding]=migratedTs.findings("legacy-run");
      assert.ok(oldFinding);
      assert.deepEqual(migratedRust.findings("legacy-run"),[oldFinding]);
      assert.deepEqual(migratedRust.decidedFindings(target.owner),migratedTs.decidedFindings(target.owner));
      assert.deepEqual(migratedRust.prediction(oldFinding.id),migratedTs.prediction(oldFinding.id));
      assert.equal(migratedTs.prediction(oldFinding.id)?.status,"insufficient-data");
    }finally{migratedTs.close();migratedRust.close();}
    assert.deepEqual(schema(oldRustPath),schema(oldTsPath));
  }
  console.log("LEARN_MODE_B_OK");
}else throw Error("invalid learning store driver option");
