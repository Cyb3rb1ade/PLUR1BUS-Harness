import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkflowEvidence } from "../../packages/core/src/skill-mining/evidence.ts";

const [step,dir]=process.argv.slice(2);assert.ok(dir);
const tsPath=join(dir,"from-ts.sqlite"),rustPath=join(dir,"from-rust.sqlite");
const scope={owner:"owner-a",agentId:"alpha",scope:"scope-a"};
const version="a".repeat(64);
const record={owner:scope.owner,agentId:scope.agentId,sessionId:"s1",turnId:"t1",callId:"from-ts",
  tool:"file.read",version,success:true};
function state(path:string){
  const db=new DatabaseSync(path);
  try{
    return {schema:db.prepare("PRAGMA user_version").get(),integrity:db.prepare("PRAGMA integrity_check").get(),
      ddl:db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='mining_executions' ORDER BY type,name").all()};
  }finally{db.close();}
}
if(step==="seed"){
  const ts=new WorkflowEvidence(tsPath);
  try{ts.record(record);}finally{ts.close();}
}else if(step==="verify"){
  const ts=new WorkflowEvidence(tsPath),rust=new WorkflowEvidence(rustPath);
  try{
    assert.equal(ts.verified(scope,"s1","t1","from-ts","file.read",version),true);
    assert.equal(ts.verified(scope,"s1","t1","rust-update","file.read",version),true);
    assert.equal(rust.verified(scope,"s1","t1","from-rust","file.read",version),true);
    assert.equal(rust.verified({...scope,agentId:"wrong"},"s1","t1","from-rust","file.read",version),false);
    rust.record({...record,callId:"ts-update",success:false});
  }finally{ts.close();rust.close();}
  assert.deepEqual(state(tsPath),state(rustPath));
  assert.equal(state(rustPath).integrity?.integrity_check,"ok");
  console.log("SKILL_EVIDENCE_MODE_B_OK");
}else throw Error("unknown Mode B action");
