import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactProvenance } from "../../packages/core/src/skill-mining/artifact-policy.ts";

const [task,dir]=process.argv.slice(2);assert.ok(dir);
const left=join(dir,"artifact-from-ts.sqlite"),right=join(dir,"artifact-from-rust.sqlite");
const artifact=join(dir,"NOTES.md");
function schema(file:string){
  const db=new DatabaseSync(file);
  try{return {ddl:db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name LIKE 'artifact_%' ORDER BY type,name").all(),
    integrity:db.prepare("PRAGMA integrity_check").get(),version:db.prepare("PRAGMA user_version").get()};}
  finally{db.close();}
}
if(task==="seed"){
  writeFileSync(artifact,"Fixture bytes");
  const ts=new ArtifactProvenance(left);
  try{ts.attribute(artifact,"agent","owner");ts.storeApprovalPolicy(false);}
  finally{ts.close();}
  console.log(realpathSync(artifact));
}else if(task==="verify"){
  const ts=new ArtifactProvenance(left),rust=new ArtifactProvenance(right);
  try{
    assert.equal(ts.approvalRequired(),true);
    assert.equal(ts.inspect(artifact).author,"agent");
    assert.equal(rust.approvalRequired(),false);
    assert.equal(rust.inspect(artifact).author,"agent");
    rust.attribute(artifact,"human","owner");
  }finally{ts.close();rust.close();}
  assert.deepEqual(schema(right),schema(left));
  assert.equal(schema(right).integrity?.integrity_check,"ok");
  console.log("SKILL_ARTIFACT_MODE_B_OK");
}else throw Error("unknown artifact driver action");
